import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { expect, it } from "vitest";

it("installs canonical triggers idempotently on a table-only local database without backfilling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openheard-bootstrap-"));
  const url = `file:${join(dir, "local.db")}`;
  const client = createClient({ url });
  const script = fileURLToPath(new URL("../../../../packages/db/scripts/notification-triggers.mjs", import.meta.url));
  const env = { ...process.env, DATABASE_URL: url };
  try {
    const missing = spawnSync(process.execPath, [script], { env, encoding: "utf8" });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("Run db:push:local");
    const migrations = new URL("../../../../packages/db/migrations/", import.meta.url);
    for (const name of readdirSync(migrations)
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await client.executeMultiple(
        readFileSync(new URL(name, migrations), "utf8").replaceAll("--> statement-breakpoint", ""),
      );
    const triggers = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'notification_%'",
    );
    for (const row of triggers.rows) await client.execute(`DROP TRIGGER "${String(row.name).replaceAll('"', '""')}"`);
    await client.execute("INSERT INTO workspace(id,name) VALUES ('default','Fixture')");
    await client.execute("INSERT INTO board(id,workspace_id,name) VALUES ('fixture','default','Fixture')");
    await client.execute("INSERT INTO post(board_id,title) VALUES ('fixture','Pre-existing fixture')");
    execFileSync(process.execPath, [script], { env });
    execFileSync(process.execPath, [script], { env });
    expect((await client.execute("SELECT count(*) n FROM notification_event")).rows[0].n).toBe(0);
    await client.execute("INSERT INTO post(board_id,title) VALUES ('fixture','New fixture')");
    expect((await client.execute("SELECT count(*) n FROM notification_event")).rows[0].n).toBe(1);
  } finally {
    client.close();
    rmSync(dir, { recursive: true });
  }
});
