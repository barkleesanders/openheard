import { readdirSync, readFileSync } from "node:fs";
import { type Client, createClient } from "@libsql/client";
import type { EmailMessage } from "@openheard/auth/email-delivery";
import { EMAIL_DESIGN_MARKER, editorialEmailHtml } from "@openheard/auth/email-template";
import type { Db } from "@openheard/db";
import * as schema from "@openheard/db/schema/index";
import { drizzle } from "drizzle-orm/libsql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@openheard/env/server", () => ({ env: {} }));

import { type DispatchConfig, dispatchNotifications } from "./notification-dispatch";
import { unsubscribeEmailSubscription } from "./subscriptions";

let client: Client;
let db: Db;
let sent: EmailMessage[];
let config: DispatchConfig;
async function member(id: string, overrides = "") {
  await client.execute({
    sql: "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?, ?, ?, 1, 0, 0)",
    args: [id, id, `${id}@example.test`],
  });
  await client.execute({
    sql: "INSERT INTO membership(workspace_id,user_id,role,created_at,notify_new_post,notify_comment,notify_status) VALUES ('default',?,'member',0,1,1,1)",
    args: [id],
  });
  if (overrides) await client.execute(overrides);
}
async function subscription(id: string, email: string, postId: number | null = 1, extra = "") {
  await client.execute({
    sql: "INSERT INTO notification_subscription(id,workspace_id,scope_key,post_id,email,confirmed_at,last_requested_at) VALUES (?,'default',?,?,?,1,0)",
    args: [id, postId === null ? "changelog" : `post:${postId}`, postId, email],
  });
  if (extra) await client.execute(extra);
}
async function event(
  kind: "post" | "comment" | "status" | "changelog" = "status",
  entityId = 1,
  actor: string | null = null,
) {
  await client.execute({
    sql: "INSERT INTO notification_event(workspace_id,kind,source_key,entity_id,actor_id,payload) VALUES ('default',?, ?, ?, ?, '{}')",
    args: [kind, crypto.randomUUID(), entityId, actor],
  });
}
beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  const migrations = new URL("../../../../packages/db/migrations/", import.meta.url);
  for (const name of readdirSync(migrations)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    await client.executeMultiple(
      readFileSync(new URL(name, migrations), "utf8").replaceAll("--> statement-breakpoint", ""),
    );
  await client.execute("PRAGMA foreign_keys=ON");
  await client.execute(
    "INSERT INTO workspace(id,name) VALUES ('default','Fixture workspace'),('other','Other fixture')",
  );
  await client.execute("INSERT INTO board(id,workspace_id,name) VALUES ('fixture','default','Fixture')");
  await client.execute(
    "INSERT INTO post(id,workspace_id,board_id,title) VALUES (1,'default','fixture','<b>Fixture request</b>')",
  );
  await client.execute("DELETE FROM notification_event");
  db = drizzle(client, { schema }) as unknown as Db;
  sent = [];
  config = {
    origin: "https://feedback.example.test",
    secret: "fixture-subscription-secret-32-characters",
    brand: "Fixture feedback",
    from: { name: "Fixture feedback", email: "feedback@notifications.example.test" },
    mailer: {
      async send(message) {
        sent.push(message);
        return { messageId: `fixture-${sent.length}` };
      },
    },
  };
});
afterEach(() => client.close());

describe("durable notification dispatch", () => {
  it("deduplicates member/subscription overlap, stores provider acceptance, and does not resend", async () => {
    await member("person");
    await subscription("fixture-subscription", "person@example.test");
    await event();
    const result = await dispatchNotifications(db, config);
    expect(result.accepted).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].html).toContain(EMAIL_DESIGN_MARKER);
    expect(sent[0].html).toContain("&lt;b&gt;Fixture request&lt;/b&gt;");
    expect(sent[0].html).not.toContain("<b>Fixture request</b>");
    expect(sent[0].html).toContain('href="https://feedback.example.test/updates?mode=unsubscribe');
    expect(sent[0].text).toContain("Manage workspace email preferences");
    expect((await db.select().from(schema.notificationDelivery))[0]).toMatchObject({
      state: "accepted",
      providerMessageId: "fixture-1",
    });
    expect((await db.select().from(schema.notificationEvent))[0].completedAt).not.toBeNull();
    await dispatchNotifications(db, config);
    expect(sent).toHaveLength(1);
  });

  it("rechecks current preferences, verified email, membership, and actor suppression", async () => {
    await member("enabled");
    await member("disabled", "UPDATE membership SET notify_status=0 WHERE user_id='disabled'");
    await member("unverified", "UPDATE user SET email_verified=0 WHERE id='unverified'");
    await member("actor");
    await member("other", "UPDATE membership SET workspace_id='other' WHERE user_id='other'");
    await event("status", 1, "actor");
    await dispatchNotifications(db, config);
    expect(sent.map((message) => message.to)).toEqual(["enabled@example.test"]);
  });

  it("excludes review requests from public subscriptions and non-admin members", async () => {
    await client.execute("UPDATE workspace SET require_approval=1 WHERE id='default'");
    await client.execute(
      "INSERT INTO status(workspace_id,key,label,color,kind) VALUES ('default','open','Review','#000000','review')",
    );
    await member("member");
    await member("admin", "UPDATE membership SET role='admin' WHERE user_id='admin'");
    await subscription("fixture-private", "subscriber@example.test");
    await event();
    await dispatchNotifications(db, config);
    expect(sent.map((message) => message.to)).toEqual(["admin@example.test"]);
    expect(sent[0].text).toContain("/dashboard/inbox?post=1");
  });

  it("suppresses a public comment that became internal before dispatch", async () => {
    await member("person");
    await client.execute("INSERT INTO comment(id,post_id,body,internal) VALUES (1,1,'Sensitive fixture',0)");
    await client.execute("UPDATE comment SET internal=1 WHERE id=1");
    await dispatchNotifications(db, config);
    expect(sent).toHaveLength(0);
  });

  it("does not send to unconfirmed, opted-out, or newly confirmed subscribers for historical events", async () => {
    await subscription(
      "pending",
      "pending@example.test",
      1,
      "UPDATE notification_subscription SET confirmed_at=NULL WHERE id='pending'",
    );
    await subscription(
      "stopped",
      "stopped@example.test",
      1,
      "UPDATE notification_subscription SET unsubscribed_at=2 WHERE id='stopped'",
    );
    await event();
    await subscription(
      "late",
      "late@example.test",
      1,
      "UPDATE notification_subscription SET confirmed_at=9999999999999 WHERE id='late'",
    );
    await dispatchNotifications(db, config);
    expect(sent).toHaveLength(0);
  });

  it("rechecks an opt-out made after planning but before a queued claim", async () => {
    await subscription("stopped-later", "subscriber@example.test");
    await event();
    const [captured] = await db.select().from(schema.notificationEvent);
    await client.execute({ sql: "UPDATE notification_event SET planned_at=2 WHERE id=?", args: [captured.id] });
    await client.execute({
      sql: "INSERT INTO notification_delivery(event_id,recipient_key) VALUES (?,'subscriber@example.test')",
      args: [captured.id],
    });
    await client.execute("UPDATE notification_subscription SET unsubscribed_at=3 WHERE id='stopped-later'");
    expect((await dispatchNotifications(db, config)).skipped).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it("does not attempt without mail configuration or retry uncertain provider outcomes", async () => {
    await member("person");
    await event();
    expect((await dispatchNotifications(db, { ...config, mailer: undefined })).configured).toBe(false);
    expect(await db.select().from(schema.notificationDelivery)).toHaveLength(0);
    config.mailer = {
      async send(message) {
        sent.push(message);
        throw new Error("private@example.test secret-token");
      },
    };
    expect((await dispatchNotifications(db, config)).unconfirmed).toBe(1);
    expect((await db.select().from(schema.notificationDelivery))[0]).toMatchObject({
      state: "unconfirmed",
      lastError: "delivery_unconfirmed_check_provider",
    });
    await dispatchNotifications(db, config);
    expect(sent).toHaveLength(1);
  });

  it("allows concurrent dispatchers to claim an address only once", async () => {
    await member("person");
    await event();
    await Promise.all([dispatchNotifications(db, config), dispatchNotifications(db, config)]);
    expect(sent).toHaveLength(1);
    expect((await db.select().from(schema.notificationDelivery))[0].state).toBe("accepted");
  });

  it("sends linked release updates only to matching confirmed scopes and provides usable unsubscribe links", async () => {
    await subscription("release", "release@example.test", null);
    await subscription("post", "post@example.test");
    await member("member");
    await client.execute("INSERT INTO changelog_entry(id,workspace_id,title) VALUES (1,'default','Fixture release')");
    await client.execute("INSERT INTO changelog_post(entry_id,post_id) VALUES (1,1)");
    await client.execute("UPDATE changelog_entry SET published_at=2 WHERE id=1");
    await dispatchNotifications(db, config);
    expect(sent.map((message) => message.to).sort()).toEqual(["post@example.test", "release@example.test"]);
    const link = new URL(sent[0].text.match(/https:\/\/\S+\/updates\?\S+/)?.[0] ?? "");
    await unsubscribeEmailSubscription(
      db,
      "default",
      link.searchParams.get("id") ?? "",
      link.searchParams.get("token") ?? "",
      config.secret,
    );
    expect((await db.select().from(schema.notificationSubscription)).filter((row) => row.unsubscribedAt)).toHaveLength(
      1,
    );
  });

  it("escapes footer labels and blocks unsafe footer links", () => {
    const html = editorialEmailHtml({
      brand: "Fixture",
      heading: "Fixture",
      paragraphs: [],
      footerLinks: [
        { label: '<img src=x onerror="alert(1)">', url: "https://example.test/?a=1&b=2" },
        { label: "Unsafe", url: "javascript:alert(1)" },
      ],
    });
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain('href="javascript:');
  });

  it("drains a bounded batch without dropping the remaining recipients", async () => {
    for (const name of ["one", "two", "three", "four", "five"]) await member(name);
    await event();
    expect((await dispatchNotifications(db, config)).accepted).toBe(3);
    expect((await db.select().from(schema.notificationEvent))[0].completedAt).toBeNull();
    expect((await dispatchNotifications(db, config)).accepted).toBe(2);
    expect(new Set(sent.map((message) => message.to)).size).toBe(5);
    expect((await db.select().from(schema.notificationEvent))[0].completedAt).not.toBeNull();
  });

  it("marks a stale in-flight claim uncertain without repeating a possible send", async () => {
    await member("person");
    await event();
    const [captured] = await db.select().from(schema.notificationEvent);
    await client.execute({ sql: "UPDATE notification_event SET planned_at=2 WHERE id=?", args: [captured.id] });
    await client.execute({
      sql: "INSERT INTO notification_delivery(event_id,recipient_key,state,attempted_at) VALUES (?,'person@example.test','sending',1)",
      args: [captured.id],
    });
    await dispatchNotifications(db, config);
    expect(sent).toHaveLength(0);
    expect((await db.select().from(schema.notificationDelivery))[0]).toMatchObject({
      state: "unconfirmed",
      lastError: "claim_expired_check_provider",
    });
    expect((await db.select().from(schema.notificationEvent))[0].completedAt).not.toBeNull();
  });

  it("does not notify followers of a linked request that has become private", async () => {
    await subscription("release", "release@example.test", null);
    await subscription("post", "post@example.test");
    await client.execute("UPDATE workspace SET require_approval=1 WHERE id='default'");
    await client.execute(
      "INSERT INTO status(workspace_id,key,label,color,kind) VALUES ('default','open','Review','#000000','review')",
    );
    await client.execute(
      "INSERT INTO changelog_entry(id,workspace_id,title,published_at) VALUES (1,'default','Public fixture release',1)",
    );
    await client.execute("INSERT INTO changelog_post(entry_id,post_id) VALUES (1,1)");
    await dispatchNotifications(db, config);
    expect(sent.map((message) => message.to)).toEqual(["release@example.test"]);
  });

  it("records no acceptance when the sender returns no provider receipt", async () => {
    await member("person");
    await event();
    config.mailer = {
      async send(message) {
        sent.push(message);
        return undefined;
      },
    };
    expect((await dispatchNotifications(db, config)).unconfirmed).toBe(1);
    const [row] = await db.select().from(schema.notificationDelivery);
    expect(row.state).toBe("unconfirmed");
    expect(row.acceptedAt).toBeNull();
    expect(row.providerMessageId).toBeNull();
  });
});
