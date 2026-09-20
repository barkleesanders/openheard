// GET /api/mcp doubles as a connectivity probe: agent hosts (Muse custom
// connectors, health checks) issue a plain authenticated GET before they ever
// speak JSON-RPC, and treat anything non-2xx as "failed to connect". These
// drive the real route handlers against a real in-memory schema.
import { createClient } from "@libsql/client";
import type { Db } from "@openheard/db";
import * as schema from "@openheard/db/schema/index";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";

const MIGRATIONS = new URL("../../../../packages/db/migrations/", import.meta.url).pathname;

async function freshDb(): Promise<Db> {
  const client = createClient({ url: ":memory:" });
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    await client.executeMultiple(readFileSync(MIGRATIONS + file, "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  await client.execute("PRAGMA foreign_keys = ON");
  return drizzle(client, { schema }) as unknown as Db;
}

// The route reaches the database through `env.DB_LOCAL` (packages/db createDb)
// and the rate limiter through `env.CACHE`; no CACHE means the in-memory store.
const testEnv: { DB?: undefined; DB_LOCAL?: Db; CACHE?: undefined } = {};
vi.mock("@openheard/env/server", () => ({ env: testEnv }));

const VALID_KEY = "oh_test_key_1234567890abcdef";
const BOGUS_KEY = "oh_bogus_key_never_issued_0000";

async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

type Handler = (ctx: { request: Request }) => Promise<Response>;
let GET: Handler;
let POST: Handler;

beforeAll(async () => {
  const db = await freshDb();
  testEnv.DB_LOCAL = db;
  await db.insert(schema.workspace).values({ id: "default" });
  await db.insert(schema.apiKey).values({
    id: "key-1",
    workspaceId: "default",
    name: "test",
    prefix: VALID_KEY.slice(0, 11),
    hash: await sha256(VALID_KEY),
  });

  const { Route } = await import("../routes/api/mcp");
  const handlers = (Route.options as { server?: { handlers?: Record<string, Handler> } }).server?.handlers;
  if (!handlers?.GET || !handlers.POST) throw new Error("route did not register GET/POST handlers");
  GET = handlers.GET;
  POST = handlers.POST;
});

function get(key: string, accept?: string) {
  const headers: Record<string, string> = { authorization: `Bearer ${key}` };
  if (accept) headers.accept = accept;
  return GET({ request: new Request("http://feedback.example.test/api/mcp", { method: "GET", headers }) });
}

describe("GET /api/mcp as a connectivity probe", () => {
  it("answers a plain authenticated GET with 200 JSON server info", async () => {
    const res = await get(VALID_KEY);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { name: string; version: string; transport: string; tools: string[]; docs: string };
    expect(body.name).toBe("openheard");
    expect(body.transport).toBe("streamable-http");
    expect(body.tools).toHaveLength(10);
    expect(body.tools).toContain("list_posts");
    expect(body.tools).toContain("publish_changelog");
    expect(body.docs).toMatch(/docs\/mcp\.md$/);
  });

  it("is what Muse's Connect button sends: Bearer key, Accept */*", async () => {
    const res = await get(VALID_KEY, "*/*");
    expect(res.status).toBe(200);
  });

  it("keeps the SDK transport when the client accepts text/event-stream", async () => {
    // Measured on @modelcontextprotocol/sdk 1.30.0 before the probe branch
    // existed: the transport opens a standalone SSE stream, 200 text/event-stream.
    const res = await get(VALID_KEY, "text/event-stream");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.body?.cancel();
  });

  it("still refuses a key that was never issued", async () => {
    const res = await get(BOGUS_KEY);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toMatch(/invalid or revoked/i);
  });

  it("still refuses a missing key", async () => {
    const res = await GET({ request: new Request("http://feedback.example.test/api/mcp") });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/mcp", () => {
  it("still lists the ten tools over JSON-RPC", async () => {
    const res = await POST({
      request: new Request("http://feedback.example.test/api/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${VALID_KEY}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: { name: string }[] } };
    const listed = body.result.tools.map((t) => t.name).sort();
    expect(listed).toEqual([
      "add_comment",
      "create_post",
      "draft_changelog",
      "get_post",
      "list_boards",
      "list_changelog",
      "list_posts",
      "list_statuses",
      "publish_changelog",
      "set_status",
    ]);

    // The probe advertises exactly what tools/list registers.
    const probe = (await (await get(VALID_KEY)).json()) as { tools: string[] };
    expect([...probe.tools].sort()).toEqual(listed);
  });
});
