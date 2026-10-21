import { deliverEmail, type EmailSender, type Mailer } from "@openheard/auth/email-delivery";
import { editorialEmailHtml, editorialEmailText } from "@openheard/auth/email-template";
import type { Db } from "@openheard/db";
import {
  changelogEntry,
  changelogPost,
  comment,
  membership,
  notificationDelivery,
  notificationEvent,
  notificationSubscription,
  post,
  status,
  user,
  workspace,
} from "@openheard/db";
import { and, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { subscriptionUnsubscribeUrl, workspaceNotificationOrigin } from "./subscriptions";

type Event = typeof notificationEvent.$inferSelect;
type Context = { title: string; postId: number | null; publiclyVisible: boolean };
export type DispatchConfig = {
  mailer?: Mailer;
  secret: string;
  origin: string;
  rootDomain?: string;
  from: EmailSender;
  brand: string;
};

async function contextFor(db: Db, event: Event): Promise<Context | null> {
  if (event.workspaceId === "demo") return null;
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, event.workspaceId)).limit(1);
  if (!ws) return null;
  if (event.kind === "changelog") {
    const [entry] = await db
      .select()
      .from(changelogEntry)
      .where(
        and(
          eq(changelogEntry.id, event.entityId),
          eq(changelogEntry.workspaceId, event.workspaceId),
          isNotNull(changelogEntry.publishedAt),
        ),
      )
      .limit(1);
    return entry ? { title: entry.title, postId: null, publiclyVisible: true } : null;
  }
  let postId = event.entityId;
  if (event.kind === "comment") {
    const [reply] = await db
      .select()
      .from(comment)
      .where(and(eq(comment.id, event.entityId), eq(comment.internal, false)))
      .limit(1);
    if (!reply) return null;
    postId = reply.postId;
  }
  const [item] = await db
    .select()
    .from(post)
    .where(and(eq(post.id, postId), eq(post.workspaceId, event.workspaceId), isNull(post.mergedIntoId)))
    .limit(1);
  if (!item) return null;
  const [state] = await db
    .select()
    .from(status)
    .where(and(eq(status.workspaceId, event.workspaceId), eq(status.key, item.status)))
    .limit(1);
  return { title: item.title, postId, publiclyVisible: !ws.requireApproval || (!!state && state.kind !== "review") };
}

function subscriptionScope(db: Db, event: Event, context: Context) {
  return event.kind === "changelog"
    ? or(
        eq(notificationSubscription.scopeKey, "changelog"),
        inArray(
          notificationSubscription.postId,
          db
            .select({ postId: changelogPost.postId })
            .from(changelogPost)
            .innerJoin(post, eq(post.id, changelogPost.postId))
            .innerJoin(workspace, eq(workspace.id, post.workspaceId))
            .leftJoin(status, and(eq(status.workspaceId, post.workspaceId), eq(status.key, post.status)))
            .where(
              and(
                eq(changelogPost.entryId, event.entityId),
                eq(post.workspaceId, event.workspaceId),
                isNull(post.mergedIntoId),
                or(eq(workspace.requireApproval, false), ne(status.kind, "review")),
              ),
            ),
        ),
      )
    : eq(notificationSubscription.postId, context.postId ?? -1);
}

// Plan with INSERT ... SELECT rather than loading the workspace address book
// into memory. Each normalized address gets one durable claim across sources.
async function plan(db: Db, event: Event, now: Date) {
  const context = await contextFor(db, event);
  if (!context) {
    await db
      .update(notificationEvent)
      .set({ plannedAt: now, completedAt: now })
      .where(eq(notificationEvent.id, event.id));
    return;
  }
  const memberPreference =
    event.kind === "post"
      ? eq(membership.notifyNewPost, true)
      : event.kind === "comment"
        ? eq(membership.notifyComment, true)
        : event.kind === "status"
          ? eq(membership.notifyStatus, true)
          : sql`0`;
  await db.batch([
    db
      .insert(notificationDelivery)
      .select(
        db
          .select({
            eventId: sql<number>`${event.id}`.as("event_id"),
            recipientKey: sql<string>`lower(trim(${user.email}))`.as("recipient_key"),
            state: sql<"queued">`'queued'`.as("state"),
            attemptedAt: sql<null>`NULL`.as("attempted_at"),
            acceptedAt: sql<null>`NULL`.as("accepted_at"),
            providerMessageId: sql<null>`NULL`.as("provider_message_id"),
            lastError: sql<null>`NULL`.as("last_error"),
          })
          .from(membership)
          .innerJoin(user, eq(user.id, membership.userId))
          .where(
            and(
              eq(membership.workspaceId, event.workspaceId),
              eq(user.emailVerified, true),
              lte(membership.createdAt, event.createdAt),
              ne(sql`trim(${user.email})`, ""),
              memberPreference,
              context.publiclyVisible ? undefined : eq(membership.role, "admin"),
              event.actorId ? ne(membership.userId, event.actorId) : undefined,
            ),
          ),
      )
      .onConflictDoNothing(),
    db
      .insert(notificationDelivery)
      .select(
        db
          .select({
            eventId: sql<number>`${event.id}`.as("event_id"),
            recipientKey: sql<string>`lower(trim(${notificationSubscription.email}))`.as("recipient_key"),
            state: sql<"queued">`'queued'`.as("state"),
            attemptedAt: sql<null>`NULL`.as("attempted_at"),
            acceptedAt: sql<null>`NULL`.as("accepted_at"),
            providerMessageId: sql<null>`NULL`.as("provider_message_id"),
            lastError: sql<null>`NULL`.as("last_error"),
          })
          .from(notificationSubscription)
          .where(
            and(
              eq(notificationSubscription.workspaceId, event.workspaceId),
              lte(notificationSubscription.confirmedAt, event.createdAt),
              isNull(notificationSubscription.unsubscribedAt),
              subscriptionScope(db, event, context),
              context.publiclyVisible ? undefined : sql`0`,
            ),
          ),
      )
      .onConflictDoNothing(),
    db.update(notificationEvent).set({ plannedAt: now }).where(eq(notificationEvent.id, event.id)),
  ]);
}

async function recipientFor(db: Db, event: Event, email: string, context: Context) {
  if (!z.email().max(254).safeParse(email).success) return null;
  if (event.actorId) {
    const [actor] = await db.select({ email: user.email }).from(user).where(eq(user.id, event.actorId)).limit(1);
    if (actor?.email.trim().toLowerCase() === email) return null;
  }
  const members = await db
    .select({ member: membership, verified: user.emailVerified })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(
      and(
        eq(membership.workspaceId, event.workspaceId),
        eq(sql`lower(trim(${user.email}))`, email),
        lte(membership.createdAt, event.createdAt),
      ),
    );
  const memberEligible = members.some(
    ({ member, verified }) =>
      verified &&
      (context.publiclyVisible || member.role === "admin") &&
      (event.kind === "post"
        ? member.notifyNewPost
        : event.kind === "comment"
          ? member.notifyComment
          : event.kind === "status"
            ? member.notifyStatus
            : false),
  );
  const subscriptions = context.publiclyVisible
    ? await db
        .select()
        .from(notificationSubscription)
        .where(
          and(
            eq(notificationSubscription.workspaceId, event.workspaceId),
            eq(notificationSubscription.email, email),
            lte(notificationSubscription.confirmedAt, event.createdAt),
            isNull(notificationSubscription.unsubscribedAt),
            subscriptionScope(db, event, context),
          ),
        )
    : [];
  if (!memberEligible && !subscriptions.length) return null;
  return { memberEligible, subscriptions };
}

const HEADINGS = {
  post: "New feedback",
  comment: "New public reply",
  status: "Request status changed",
  changelog: "New release published",
};

export async function dispatchNotifications(db: Db, config: DispatchConfig, now = new Date()) {
  const result = {
    configured: !!config.mailer && config.secret.length >= 32,
    planned: 0,
    claimed: 0,
    accepted: 0,
    skipped: 0,
    unconfirmed: 0,
  };
  if (!result.configured) return result;
  // A crash after claiming is an uncertain outcome, never a blind retry.
  const expired = await db
    .update(notificationDelivery)
    .set({ state: "unconfirmed", lastError: "claim_expired_check_provider" })
    .where(
      and(
        eq(notificationDelivery.state, "sending"),
        lte(notificationDelivery.attemptedAt, new Date(now.getTime() - 5 * 60_000)),
      ),
    )
    .returning({ eventId: notificationDelivery.eventId });
  const events = await db
    .select()
    .from(notificationEvent)
    .where(isNull(notificationEvent.plannedAt))
    .orderBy(notificationEvent.id)
    // Small ticks leave the durable backlog intact and fit D1's free-plan
    // 50-query invocation allowance: https://developers.cloudflare.com/d1/platform/limits/
    .limit(2);
  for (const event of events) {
    await plan(db, event, now);
    result.planned++;
  }
  const queue = await db
    .select({ delivery: notificationDelivery, event: notificationEvent })
    .from(notificationDelivery)
    .innerJoin(notificationEvent, eq(notificationEvent.id, notificationDelivery.eventId))
    .where(eq(notificationDelivery.state, "queued"))
    .orderBy(notificationDelivery.eventId, notificationDelivery.recipientKey)
    .limit(3);
  for (const { delivery, event } of queue) {
    // Validate configuration before claiming; configuration failures sent nothing.
    const origin = workspaceNotificationOrigin(event.workspaceId, config.origin, config.rootDomain);
    const condition = and(
      eq(notificationDelivery.eventId, event.id),
      eq(notificationDelivery.recipientKey, delivery.recipientKey),
    );
    const claimed = await db
      .update(notificationDelivery)
      .set({ state: "sending", attemptedAt: now })
      .where(and(condition, eq(notificationDelivery.state, "queued")))
      .returning({ eventId: notificationDelivery.eventId });
    if (claimed.length !== 1) continue;
    result.claimed++;
    try {
      const context = await contextFor(db, event);
      const recipient = context ? await recipientFor(db, event, delivery.recipientKey, context) : null;
      if (!context || !recipient) {
        await db
          .update(notificationDelivery)
          .set({ state: "skipped", lastError: "no_longer_eligible" })
          .where(condition);
        result.skipped++;
        continue;
      }
      const footerLinks: { label: string; url: string }[] = [];
      if (recipient.memberEligible)
        footerLinks.push({
          label: "Manage workspace email preferences",
          url: `${origin}/dashboard/settings/notifications`,
        });
      for (const row of recipient.subscriptions)
        footerLinks.push({
          label: row.postId === null ? "Unsubscribe from release updates" : `Unsubscribe from request #${row.postId}`,
          url: await subscriptionUnsubscribeUrl(origin, config.secret, row),
        });
      const path =
        event.kind === "changelog"
          ? "/changelog"
          : context.publiclyVisible
            ? `/p/${context.postId}`
            : `/dashboard/inbox?post=${context.postId}`;
      const message = {
        brand: config.brand,
        heading: HEADINGS[event.kind],
        paragraphs: [context.title, "Open the feedback board to see the current discussion and status."],
        cta: { label: event.kind === "changelog" ? "Read the release" : "View request", url: `${origin}${path}` },
        footer:
          "You receive this because of your workspace email preferences or a confirmed subscription. Each subscription can be stopped separately.",
        footerLinks,
      };
      const accepted = await deliverEmail(config.mailer, {
        to: delivery.recipientKey,
        from: config.from,
        subject: HEADINGS[event.kind],
        html: editorialEmailHtml(message),
        text: editorialEmailText(message),
      });
      await db
        .update(notificationDelivery)
        .set({ state: "accepted", acceptedAt: now, providerMessageId: accepted.messageId, lastError: null })
        .where(condition);
      result.accepted++;
    } catch {
      await db
        .update(notificationDelivery)
        .set({ state: "unconfirmed", lastError: "delivery_unconfirmed_check_provider" })
        .where(condition);
      result.unconfirmed++;
    }
  }
  const touched = [
    ...new Set([
      ...expired.map((row) => row.eventId),
      ...events.map((row) => row.id),
      ...queue.map((row) => row.event.id),
    ]),
  ];
  // Chunk under D1's 100-bound-parameter limit. Keep untouched history off the
  // scheduled hot path; remaining queued work is durable for the next tick.
  for (let index = 0; index < touched.length; index += 40) {
    await db
      .update(notificationEvent)
      .set({ completedAt: now })
      .where(
        and(
          inArray(notificationEvent.id, touched.slice(index, index + 40)),
          isNotNull(notificationEvent.plannedAt),
          isNull(notificationEvent.completedAt),
          sql`NOT EXISTS (SELECT 1 FROM notification_delivery d WHERE d.event_id = ${notificationEvent.id} AND d.state IN ('queued', 'sending'))`,
        ),
      );
  }
  return result;
}
