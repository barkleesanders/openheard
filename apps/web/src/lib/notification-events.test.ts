import { readdirSync, readFileSync } from "node:fs";
import { type Client, createClient } from "@libsql/client";
import type { Db } from "@openheard/db";
import * as schema from "@openheard/db/schema/index";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_WORKSPACE_ID } from "./demo";

vi.mock("@openheard/env/server", () => ({ env: {} }));

import {
  mutateAddComment,
  mutateCreatePost,
  mutateDraftChangelog,
  mutatePublishChangelog,
  mutateSetStatus,
} from "./api-actions";

let client: Client;
const migrations = new URL("../../../../packages/db/migrations/", import.meta.url);
async function count() {
  return Number((await client.execute("SELECT COUNT(*) AS n FROM notification_event")).rows[0].n);
}
async function addPost(workspace = "default") {
  const result = await client.execute({
    sql: "INSERT INTO post (workspace_id, board_id, author_id, title, body) VALUES (?, ?, 'fixture-user', 'Fixture request', 'Public fixture body') RETURNING id",
    args: [workspace, `board-${workspace}`],
  });
  return Number(result.rows[0].id);
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const name of readdirSync(migrations)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    await client.executeMultiple(
      readFileSync(new URL(name, migrations), "utf8").replaceAll("--> statement-breakpoint", ""),
    );
  }
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('fixture-user', 'Fixture user', 'fixture@example.test', 1, 0, 0)",
  );
  for (const workspace of ["default", "other", DEMO_WORKSPACE_ID]) {
    await client.execute({
      sql: "INSERT OR IGNORE INTO workspace (id, name) VALUES (?, 'Fixture workspace')",
      args: [workspace],
    });
    await client.execute({
      sql: "INSERT INTO board (id, workspace_id, name) VALUES (?, ?, 'Fixture board')",
      args: [`board-${workspace}`, workspace],
    });
  }
});
afterEach(() => client?.close());

describe("durable notification event capture", () => {
  it("keeps the typed schema aligned with the canonical deployed migration", async () => {
    for (const [name, table] of [
      ["notification_event", schema.notificationEvent],
      ["notification_delivery", schema.notificationDelivery],
    ] as const) {
      const columns = (await client.execute(`PRAGMA table_info(${name})`)).rows.map((row) => String(row.name)).sort();
      expect(columns).toEqual(
        Object.values(getTableColumns(table))
          .map((column) => column.name)
          .sort(),
      );
    }
  });
  it("records real post writes atomically and excludes the public demo", async () => {
    const id = await addPost();
    const events = (await client.execute("SELECT * FROM notification_event")).rows;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ workspace_id: "default", kind: "post", entity_id: id, actor_id: "fixture-user" });
    expect(JSON.parse(String(events[0].payload))).toMatchObject({ postId: id, title: "Fixture request" });
    await addPost(DEMO_WORKSPACE_ID);
    expect(await count()).toBe(1);
    expect(DEMO_WORKSPACE_ID).toBe("demo");
  });
  it("captures only public comments in the post's own workspace", async () => {
    const id = await addPost("other");
    await client.execute({
      sql: "INSERT INTO comment (post_id, author_id, body, internal) VALUES (?, 'fixture-user', 'Private fixture note', 1)",
      args: [id],
    });
    expect(await count()).toBe(1);
    await client.execute({
      sql: "INSERT INTO comment (post_id, author_id, body, internal) VALUES (?, 'fixture-user', 'Public fixture reply', 0)",
      args: [id],
    });
    const events = (await client.execute("SELECT * FROM notification_event WHERE kind = 'comment'")).rows;
    expect(events).toHaveLength(1);
    expect(events[0].workspace_id).toBe("other");
    expect(String(events[0].payload)).not.toContain("Private fixture note");
  });
  it("records each actual status transition once, including direct API-style updates", async () => {
    const id = await addPost();
    for (const status of ["planned", "planned", "done", "open"])
      await client.execute({ sql: "UPDATE post SET status = ? WHERE id = ?", args: [status, id] });
    const events = (await client.execute("SELECT * FROM notification_event WHERE kind = 'status' ORDER BY id")).rows;
    expect(events).toHaveLength(3);
    expect(events.map((event) => JSON.parse(String(event.payload)).toStatus)).toEqual(["planned", "done", "open"]);
    expect(new Set(events.map((event) => event.source_key)).size).toBe(3);
  });
  it("captures first publication, never a draft, edit, or duplicate republish", async () => {
    const entry = await client.execute(
      "INSERT INTO changelog_entry (workspace_id, title, body) VALUES ('default', 'Fixture release', 'Release body') RETURNING id",
    );
    const id = Number(entry.rows[0].id);
    expect(await count()).toBe(0);
    for (const publishedAt of [1, 2, null, 3])
      await client.execute({
        sql: "UPDATE changelog_entry SET published_at = ? WHERE id = ?",
        args: [publishedAt, id],
      });
    expect(await count()).toBe(1);
    await client.execute(
      "INSERT INTO changelog_entry (workspace_id, title, body, published_at) VALUES ('default', 'Immediately published', 'Public body', 4)",
    );
    expect(await count()).toBe(2);
  });
  it("rolls event records back together with the original write", async () => {
    // libsql's transaction() transfers its connection away from the client;
    // reopening :memory: would create a different, empty database. Keep this
    // rollback check on the same connection so it measures the trigger.
    await client.execute("BEGIN IMMEDIATE");
    await client.execute(
      "INSERT INTO post (workspace_id, board_id, title) VALUES ('default', 'board-default', 'Rolled back fixture')",
    );
    expect(await count()).toBe(1);
    await client.execute("ROLLBACK");
    expect(await count()).toBe(0);
  });
  it("deduplicates recipients and refuses an accepted state without provider evidence", async () => {
    await addPost();
    const eventId = Number((await client.execute("SELECT id FROM notification_event")).rows[0].id);
    const args = [eventId, "user:fixture-user"];
    await client.execute({ sql: "INSERT INTO notification_delivery (event_id, recipient_key) VALUES (?, ?)", args });
    await expect(
      client.execute({ sql: "INSERT INTO notification_delivery (event_id, recipient_key) VALUES (?, ?)", args }),
    ).rejects.toThrow();
    await expect(client.execute("UPDATE notification_delivery SET state = 'accepted'")).rejects.toThrow();
    await client.execute(
      "UPDATE notification_delivery SET state = 'accepted', provider_message_id = 'fixture-message', accepted_at = 1",
    );
    expect((await client.execute("SELECT state FROM notification_delivery")).rows[0].state).toBe("accepted");
  });
  it("captures events from the actual shared API/MCP mutation functions", async () => {
    const db = drizzle(client, { schema }) as unknown as Db;
    await client.execute(
      "INSERT INTO status (workspace_id, key, label, color, kind, position, on_roadmap) VALUES ('default', 'planned', 'Planned', '#f2b53d', 'planned', 1, 1), ('default', 'done', 'Shipped', '#3ecf8e', 'done', 2, 1)",
    );
    const created = await mutateCreatePost(db, "default", { title: "API fixture request", boardId: "board-default" });
    await mutateAddComment(db, "default", created.id, "API public reply");
    await mutateSetStatus(db, "default", created.id, "planned");
    const release = await mutateDraftChangelog(db, "default", { title: "API fixture release", postIds: [created.id] });
    await mutatePublishChangelog(db, "default", release.id);
    const totals = (
      await client.execute("SELECT kind, COUNT(*) AS n FROM notification_event GROUP BY kind ORDER BY kind")
    ).rows;
    expect(totals.map((row) => [row.kind, Number(row.n)])).toEqual([
      ["changelog", 1],
      ["comment", 1],
      ["post", 1],
      ["status", 2],
    ]);
    const before = await count();
    await expect(mutateSetStatus(db, "other", created.id, "planned")).rejects.toThrow("Post not found");
    expect(await count()).toBe(before);
  });
  it("workspace deletion cascades notification rows after legacy content cleanup", async () => {
    await addPost();
    await addPost("other");
    await client.execute(
      "INSERT INTO notification_delivery(event_id,recipient_key) SELECT id, 'user:fixture-user' FROM notification_event",
    );
    // Existing content migrations use restrictive workspace FKs, despite the
    // older typed schema's cascade metadata. Respect those real constraints;
    // this test measures the new event/delivery cascade, not a content purge.
    await client.execute("DELETE FROM post WHERE workspace_id='other'");
    await client.execute("DELETE FROM board WHERE workspace_id='other'");
    await client.execute("DELETE FROM workspace WHERE id='other'");
    expect(
      (await client.execute("SELECT workspace_id FROM notification_event")).rows.map((row) => row.workspace_id),
    ).toEqual(["default"]);
    expect(Number((await client.execute("SELECT COUNT(*) AS n FROM notification_delivery")).rows[0].n)).toBe(1);
  });
});
