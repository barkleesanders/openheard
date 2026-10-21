import { deliverEmail, EmailDeliveryError, type Mailer } from "@openheard/auth/email-delivery";
import { editorialEmailHtml, editorialEmailText } from "@openheard/auth/email-template";
import type { Db } from "@openheard/db";
import { notificationSubscription, post, status, workspace } from "@openheard/db";
import { and, eq, gt, isNotNull, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import { DEMO_WORKSPACE_ID } from "./demo";

export type SubscriptionMail = {
  origin: string;
  brand: string;
  from: { email: string; name: string };
  mailer?: Mailer;
};
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_COOLDOWN_MS = 60 * 1000;
const encoder = new TextEncoder();
const hex = (buffer: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
export async function subscriptionTokenHash(token: string) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(token)));
}

export function subscriptionOrigin(value: string) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error("Invalid notification origin");
  return url.origin;
}

async function publicScope(db: Db, workspaceId: string, postId?: number | null) {
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, workspaceId)).limit(1);
  if (!ws || ws.id === DEMO_WORKSPACE_ID) throw new Error("Email updates are unavailable here");
  if (postId != null) {
    const [p] = await db
      .select({ status: post.status })
      .from(post)
      .where(and(eq(post.id, postId), eq(post.workspaceId, workspaceId), isNull(post.mergedIntoId)))
      .limit(1);
    if (!p) throw new Error("Post is not publicly available");
    if (ws.requireApproval) {
      const [state] = await db
        .select({ kind: status.kind })
        .from(status)
        .where(and(eq(status.workspaceId, workspaceId), eq(status.key, p.status)))
        .limit(1);
      if (!state || state.kind === "review") throw new Error("Post is not publicly available");
    }
  }
  return ws;
}

export async function requestEmailSubscription(
  db: Db,
  workspaceId: string,
  input: { email: string; postId?: number },
  mail: SubscriptionMail,
  now = new Date(),
) {
  const email = z.email().max(254).parse(input.email.trim().toLowerCase());
  if (input.postId !== undefined && (!Number.isSafeInteger(input.postId) || input.postId < 1))
    throw new Error("Invalid post");
  const origin = subscriptionOrigin(mail.origin);
  const ws = await publicScope(db, workspaceId, input.postId);
  if (!mail.mailer) throw new EmailDeliveryError("unavailable");
  const scopeKey = input.postId === undefined ? "changelog" : `post:${input.postId}`;
  const [existing] = await db
    .select()
    .from(notificationSubscription)
    .where(
      and(
        eq(notificationSubscription.workspaceId, workspaceId),
        eq(notificationSubscription.scopeKey, scopeKey),
        eq(notificationSubscription.email, email),
      ),
    )
    .limit(1);
  // Identical public responses avoid disclosing whether an address is enrolled.
  if (existing?.confirmedAt && !existing.unsubscribedAt) return { requested: true };
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await subscriptionTokenHash(token);
  const tokenExpiresAt = new Date(now.getTime() + TOKEN_TTL_MS);
  const reserved = await db
    .insert(notificationSubscription)
    .values({
      id: crypto.randomUUID(),
      workspaceId,
      scopeKey,
      postId: input.postId ?? null,
      email,
      tokenHash,
      tokenExpiresAt,
      lastRequestedAt: now,
    })
    .onConflictDoUpdate({
      target: [notificationSubscription.workspaceId, notificationSubscription.scopeKey, notificationSubscription.email],
      set: { tokenHash, tokenExpiresAt, lastRequestedAt: now },
      setWhere: and(
        lte(notificationSubscription.lastRequestedAt, new Date(now.getTime() - REQUEST_COOLDOWN_MS)),
        or(isNull(notificationSubscription.confirmedAt), isNotNull(notificationSubscription.unsubscribedAt)),
      ),
    })
    .returning({ id: notificationSubscription.id });
  if (!reserved.length) return { requested: true };
  const link = new URL("/updates", origin);
  link.search = new URLSearchParams({ mode: "confirm", id: reserved[0].id, token }).toString();
  const message = {
    brand: mail.brand,
    heading: "Confirm email updates",
    paragraphs: [
      `Confirm that you requested ${input.postId === undefined ? "release updates" : "updates about a request"} from ${ws.name}.`,
    ],
    cta: { label: "Confirm subscription", url: link.href },
    footer:
      "This link expires in 24 hours. If you did not request these updates, ignore this email. You will not be subscribed.",
  };
  await deliverEmail(mail.mailer, {
    to: email,
    from: mail.from,
    subject: "Confirm your feedback updates",
    html: editorialEmailHtml(message),
    text: editorialEmailText(message),
  });
  return { requested: true };
}

export async function confirmEmailSubscription(
  db: Db,
  workspaceId: string,
  id: string,
  token: string,
  now = new Date(),
) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Link is invalid or expired");
  const [row] = await db
    .select()
    .from(notificationSubscription)
    .where(
      and(
        eq(notificationSubscription.id, id),
        eq(notificationSubscription.workspaceId, workspaceId),
        eq(notificationSubscription.tokenHash, await subscriptionTokenHash(token)),
        gt(notificationSubscription.tokenExpiresAt, now),
      ),
    )
    .limit(1);
  if (!row) throw new Error("Link is invalid or expired");
  await publicScope(db, workspaceId, row.postId);
  const changed = await db
    .update(notificationSubscription)
    .set({ confirmedAt: now, unsubscribedAt: null, tokenHash: null, tokenExpiresAt: null })
    .where(
      and(
        eq(notificationSubscription.id, id),
        eq(notificationSubscription.workspaceId, workspaceId),
        eq(notificationSubscription.tokenHash, row.tokenHash ?? ""),
        gt(notificationSubscription.tokenExpiresAt, now),
      ),
    )
    .returning({ id: notificationSubscription.id });
  if (changed.length !== 1) throw new Error("Link is invalid or expired");
  return { confirmed: true };
}

type Subscription = typeof notificationSubscription.$inferSelect;
function unsubscribePayload(row: Subscription) {
  return encoder.encode(
    JSON.stringify(["unsubscribe", row.workspaceId, row.id, row.email, row.confirmedAt?.getTime()]),
  );
}
async function unsubscribeKey(secret: string, usage: "sign" | "verify") {
  if (secret.length < 32) throw new Error("Notification signing is unavailable");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}
async function unsubscribeSignature(secret: string, row: Subscription) {
  if (secret.length < 32 || !row.confirmedAt) throw new Error("Notification signing is unavailable");
  return hex(await crypto.subtle.sign("HMAC", await unsubscribeKey(secret, "sign"), unsubscribePayload(row)));
}

export async function subscriptionUnsubscribeUrl(origin: string, secret: string, row: Subscription) {
  const url = new URL("/updates", subscriptionOrigin(origin));
  url.search = new URLSearchParams({
    mode: "unsubscribe",
    id: row.id,
    token: await unsubscribeSignature(secret, row),
  }).toString();
  return url.href;
}

export async function unsubscribeEmailSubscription(
  db: Db,
  workspaceId: string,
  id: string,
  token: string,
  secret: string,
  now = new Date(),
) {
  const [row] = await db
    .select()
    .from(notificationSubscription)
    .where(and(eq(notificationSubscription.id, id), eq(notificationSubscription.workspaceId, workspaceId)))
    .limit(1);
  if (!row?.confirmedAt || !/^[a-f0-9]{64}$/.test(token)) throw new Error("Link is invalid or expired");
  const signature = Uint8Array.from({ length: 32 }, (_, index) => parseInt(token.slice(index * 2, index * 2 + 2), 16));
  if (!(await crypto.subtle.verify("HMAC", await unsubscribeKey(secret, "verify"), signature, unsubscribePayload(row))))
    throw new Error("Link is invalid or expired");
  const changed = await db
    .update(notificationSubscription)
    .set({ unsubscribedAt: row.unsubscribedAt ?? now })
    .where(
      and(
        eq(notificationSubscription.id, id),
        eq(notificationSubscription.workspaceId, workspaceId),
        eq(notificationSubscription.confirmedAt, row.confirmedAt),
      ),
    )
    .returning({ id: notificationSubscription.id });
  if (changed.length !== 1) throw new Error("Link is invalid or expired");
  return { unsubscribed: true };
}
