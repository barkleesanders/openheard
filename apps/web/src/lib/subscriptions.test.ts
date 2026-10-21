import { readdirSync, readFileSync } from "node:fs";
import { type Client, createClient } from "@libsql/client";
import type { EmailMessage } from "@openheard/auth/email-delivery";
import { EMAIL_DESIGN_MARKER } from "@openheard/auth/email-template";
import type { Db } from "@openheard/db";
import * as schema from "@openheard/db/schema/index";
import { drizzle } from "drizzle-orm/libsql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@openheard/env/server", () => ({ env: {} }));

import {
  confirmEmailSubscription,
  requestEmailSubscription,
  subscriptionOrigin,
  subscriptionUnsubscribeUrl,
  unsubscribeEmailSubscription,
} from "./subscriptions";

let client: Client;
let db: Db;
const sent: EmailMessage[] = [];
const now = new Date("2026-10-20T12:00:00Z");
const secret = "fixture-subscription-secret-32-characters";
const mail = {
  origin: "https://feedback.example.test",
  brand: "Example Feedback",
  from: { email: "feedback@notifications.example.test", name: "Example Feedback" },
  mailer: {
    async send(message: EmailMessage) {
      sent.push(message);
      return { messageId: "fixture-accepted" };
    },
  },
};
function confirmation() {
  const url = new URL(sent.at(-1)?.text.match(/https:\/\/\S+/)?.[0] ?? "");
  return { id: url.searchParams.get("id") ?? "", token: url.searchParams.get("token") ?? "" };
}
async function current() {
  return (await db.select().from(schema.notificationSubscription))[0];
}

beforeEach(async () => {
  sent.length = 0;
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
    "INSERT INTO workspace(id,name) VALUES ('default','Fixture workspace'),('other','Other fixture'),('demo','Public demo')",
  );
  db = drizzle(client, { schema }) as unknown as Db;
});
afterEach(() => client.close());

describe("explicit, verified email subscriptions", () => {
  it("queues no enrollment until confirmation and stores only a hash of the token", async () => {
    await requestEmailSubscription(db, "default", { email: " Person@Example.Test " }, mail, now);
    const row = await current();
    const link = confirmation();
    expect(row.email).toBe("person@example.test");
    expect(row.confirmedAt).toBeNull();
    expect(row.tokenHash).toHaveLength(64);
    expect(JSON.stringify(row)).not.toContain(link.token);
    expect(sent[0].from).toEqual(mail.from);
    expect(sent[0].html).toContain(EMAIL_DESIGN_MARKER);
    expect(sent[0].text).toContain("24 hours");
    await confirmEmailSubscription(db, "default", link.id, link.token, now);
    expect((await current()).confirmedAt?.getTime()).toBe(now.getTime());
    expect((await current()).tokenHash).toBeNull();
    await expect(confirmEmailSubscription(db, "default", link.id, link.token, now)).rejects.toThrow("Link is invalid");
  });
  it("confirmation is scoped to a workspace, rejects tampering and expires", async () => {
    await requestEmailSubscription(db, "default", { email: "person@example.test" }, mail, now);
    const { id, token } = confirmation();
    await expect(confirmEmailSubscription(db, "other", id, token, now)).rejects.toThrow();
    await expect(confirmEmailSubscription(db, "default", id, "f".repeat(64), now)).rejects.toThrow();
    await expect(
      confirmEmailSubscription(db, "default", id, token, new Date(now.getTime() + 25 * 3600000)),
    ).rejects.toThrow();
    expect((await current()).confirmedAt).toBeNull();
  });
  it("concurrent requests reserve one confirmation message and do not reset the pending token", async () => {
    await Promise.all(
      Array.from({ length: 6 }, () =>
        requestEmailSubscription(db, "default", { email: "person@example.test" }, mail, now),
      ),
    );
    expect(sent).toHaveLength(1);
    expect(await db.select().from(schema.notificationSubscription)).toHaveLength(1);
    const { id, token } = confirmation();
    await confirmEmailSubscription(db, "default", id, token, now);
  });
  it("confirmed subscriptions are not re-enrolled or emailed again", async () => {
    await requestEmailSubscription(db, "default", { email: "person@example.test" }, mail, now);
    const { id, token } = confirmation();
    await confirmEmailSubscription(db, "default", id, token, now);
    await requestEmailSubscription(
      db,
      "default",
      { email: "person@example.test" },
      mail,
      new Date(now.getTime() + 120000),
    );
    expect(sent).toHaveLength(1);
    expect((await current()).tokenHash).toBeNull();
  });
  it("unsubscribe is scoped, signed, idempotent and survives a new unconfirmed request", async () => {
    await requestEmailSubscription(db, "default", { email: "person@example.test" }, mail, now);
    const confirm = confirmation();
    await confirmEmailSubscription(db, "default", confirm.id, confirm.token, now);
    const url = new URL(await subscriptionUnsubscribeUrl(mail.origin, secret, await current()));
    const token = url.searchParams.get("token") ?? "";
    await expect(unsubscribeEmailSubscription(db, "other", confirm.id, token, secret, now)).rejects.toThrow();
    await expect(
      unsubscribeEmailSubscription(db, "default", confirm.id, "0".repeat(64), secret, now),
    ).rejects.toThrow();
    await unsubscribeEmailSubscription(db, "default", confirm.id, token, secret, now);
    await unsubscribeEmailSubscription(db, "default", confirm.id, token, secret, now);
    await requestEmailSubscription(
      db,
      "default",
      { email: "person@example.test" },
      mail,
      new Date(now.getTime() + 120000),
    );
    expect((await current()).unsubscribedAt).not.toBeNull();
    const again = confirmation();
    await confirmEmailSubscription(db, "default", again.id, again.token, new Date(now.getTime() + 130000));
    expect((await current()).unsubscribedAt).toBeNull();
    await expect(unsubscribeEmailSubscription(db, "default", confirm.id, token, secret, now)).rejects.toThrow();
  });
  it("missing or failed sending never falsely confirms the subscription or logs secrets", async () => {
    await expect(
      requestEmailSubscription(db, "default", { email: "person@example.test" }, { ...mail, mailer: undefined }, now),
    ).rejects.toThrow("Email");
    expect(await db.select().from(schema.notificationSubscription)).toHaveLength(0);
    const failure = {
      ...mail,
      mailer: {
        async send() {
          throw new Error("private recipient/token");
        },
      },
    };
    await expect(
      requestEmailSubscription(db, "default", { email: "person@example.test" }, failure, now),
    ).rejects.toThrow("Email delivery could not be confirmed");
    expect((await current()).confirmedAt).toBeNull();
  });
  it("rejects invalid email, demo, cross-workspace and unapproved post subscriptions", async () => {
    await expect(requestEmailSubscription(db, "default", { email: "bad" }, mail, now)).rejects.toThrow();
    await expect(requestEmailSubscription(db, "demo", { email: "person@example.test" }, mail, now)).rejects.toThrow();
    await client.execute("INSERT INTO board(id,workspace_id,name) VALUES ('fixture-board','default','Fixture')");
    const post = await client.execute(
      "INSERT INTO post(workspace_id,board_id,title,status) VALUES ('default','fixture-board','Review fixture','review') RETURNING id",
    );
    const postId = Number(post.rows[0].id);
    await expect(
      requestEmailSubscription(db, "other", { email: "person@example.test", postId }, mail, now),
    ).rejects.toThrow();
    await client.execute("UPDATE workspace SET require_approval=1 WHERE id='default'");
    await client.execute(
      "INSERT INTO status(workspace_id,key,label,color,kind,position,on_roadmap) VALUES ('default','review','Review','#fff','review',0,0)",
    );
    await expect(
      requestEmailSubscription(db, "default", { email: "person@example.test", postId }, mail, now),
    ).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });
  it("permits HTTPS or loopback origins, never an external HTTP or credential-bearing origin", () => {
    expect(subscriptionOrigin("https://feedback.example.test/path")).toBe(mail.origin);
    expect(subscriptionOrigin("http://127.0.0.1:18851")).toBe("http://127.0.0.1:18851");
    expect(() => subscriptionOrigin("http://untrusted.example.test")).toThrow();
    expect(() => subscriptionOrigin("https://user:password@feedback.example.test")).toThrow();
  });
});
