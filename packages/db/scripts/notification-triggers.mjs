import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";

// drizzle-kit push creates tables and indexes, but does not install triggers.
// Use the same canonical trigger DDL as deployed D1, without replaying migrations
// over an existing contributor database or touching historical rows.
const url = process.env.DATABASE_URL ?? new URL("../../../apps/web/local.db", import.meta.url).href;
if (!url.startsWith("file:")) throw new Error("Notification bootstrap accepts local file databases only");
const client = createClient({ url });
try {
  for (const table of ["notification_event", "notification_delivery", "notification_subscription"]) {
    const found = await client.execute({ sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?", args: [table] });
    if (found.rows.length !== 1) throw new Error("Run db:push:local before installing notification triggers");
  }
  const migration = readFileSync(new URL("../migrations/0011_notification_events.sql", import.meta.url), "utf8");
  const start = migration.indexOf("CREATE TRIGGER ");
  if (start < 0) throw new Error("Canonical notification trigger DDL missing");
  const triggers = migration.slice(start).replaceAll("CREATE TRIGGER ", "CREATE TRIGGER IF NOT EXISTS ");
  await client.executeMultiple(`BEGIN IMMEDIATE;\n${triggers}\nCOMMIT;`);
  console.log("Local notification triggers installed; existing content was not backfilled.");
} finally {
  client.close();
}
