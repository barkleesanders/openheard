import { readdirSync, readFileSync } from "node:fs";
import { type Client, createClient } from "@libsql/client";
import type { EmailMessage, Mailer } from "@openheard/auth/email-delivery";
import type { Db } from "@openheard/db";
import * as schema from "@openheard/db/schema/index";
import { drizzle } from "drizzle-orm/libsql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const base = "https://feedback.example.test";
const state = vi.hoisted(() => ({
  db: null as Db | null,
  workspace: { id: "default" } as { id: string } | null,
  allowed: true,
  sent: [] as EmailMessage[],
  env: {
    EMAIL: undefined as Mailer | undefined,
    AUTH_EMAIL_FROM: "feedback@notifications.example.test",
    AUTH_EMAIL_FROM_NAME: "Example Feedback",
    BETTER_AUTH_URL: "https://feedback.example.test",
    BETTER_AUTH_SECRET: "fixture-subscription-secret-32-characters",
    ROOT_DOMAIN: "",
  },
}));
vi.mock("@openheard/env/server", () => ({ env: state.env }));
vi.mock("@openheard/db", async (original) => ({
  ...(await original<typeof import("@openheard/db")>()),
  createDb: () => {
    if (!state.db) throw new Error("Fixture DB missing");
    return state.db;
  },
}));
vi.mock("./session", () => ({ workspaceFromRequest: async () => state.workspace }));
vi.mock("./rate-limit", () => ({
  rateLimit: async () => (state.allowed ? { allowed: true, retryAfter: null } : { allowed: false, retryAfter: 10 }),
}));

import { Route } from "../routes/api/updates";
import { handleSubscriptionRequest } from "./subscription-api";
import { subscriptionUnsubscribeUrl } from "./subscriptions";

let client: Client;
async function call(method: string, body?: unknown, origin: string | null = base, contentType = "application/json") {
  return handleSubscriptionRequest(
    new Request(`${base}/api/updates?action=request&email=ignored@example.test`, {
      method,
      headers: {
        "Content-Type": contentType,
        ...(origin ? { Origin: origin } : {}),
        "CF-Connecting-IP": "203.0.113.99",
      },
      ...(method === "GET" ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    }),
  );
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
  await client.execute(
    "INSERT INTO workspace(id,name) VALUES ('default','Fixture workspace'),('other','Other fixture')",
  );
  state.db = drizzle(client, { schema }) as unknown as Db;
  state.sent = [];
  state.workspace = { id: "default" };
  state.allowed = true;
  state.env.ROOT_DOMAIN = "";
  state.env.EMAIL = {
    async send(message) {
      state.sent.push(message);
      return { messageId: "fixture-only" };
    },
  };
});
afterEach(() => client.close());

describe("public subscription API", () => {
  it("registers the actual application GET and POST routes", () => {
    expect(Object.keys(Route.options.server?.handlers ?? {})).toEqual(["GET", "POST"]);
  });
  it("GET reports capabilities without sending, enrolling, or acting on query parameters", async () => {
    const response = await call("GET");
    expect(response.status).toBe(200);
    expect(((await response.json()) as { method: string }).method).toBe("POST");
    expect(state.sent).toHaveLength(0);
    expect(await state.db?.select().from(schema.notificationSubscription)).toHaveLength(0);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });
  it.each([null, "https://untrusted.example.test"])("rejects origin %s before any send", async (origin) => {
    expect((await call("POST", { action: "request", email: "person@example.test" }, origin)).status).toBe(403);
    expect(state.sent).toHaveLength(0);
  });
  it("rejects wrong methods, content types, malformed or oversized bodies", async () => {
    expect((await call("PUT", {})).status).toBe(405);
    expect((await call("POST", {}, base, "text/plain")).status).toBe(415);
    expect((await call("POST", "{")).status).toBe(400);
    expect((await call("POST", "x".repeat(4096))).status).toBe(413);
    expect(state.sent).toHaveLength(0);
  });
  it("rate limits before sending and returns a retry interval", async () => {
    state.allowed = false;
    const response = await call("POST", { action: "request", email: "person@example.test" });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("10");
    expect(state.sent).toHaveLength(0);
  });
  it("runs request and confirmation through the real storage and captured sender", async () => {
    expect((await call("POST", { action: "request", email: "person@example.test" })).status).toBe(200);
    expect(state.sent).toHaveLength(1);
    const link = new URL(state.sent[0].text.match(/https:\/\/\S+/)?.[0] ?? "");
    expect(link.origin).toBe(base);
    const action = { action: "confirm", id: link.searchParams.get("id"), token: link.searchParams.get("token") };
    state.workspace = { id: "other" };
    expect((await call("POST", action)).status).toBe(400);
    state.workspace = { id: "default" };
    const response = await call("POST", action);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { confirmed: boolean }).confirmed).toBe(true);
    expect((await call("POST", action)).status).toBe(400);
    if (!state.db) throw new Error("Fixture DB missing");
    const [subscription] = await state.db.select().from(schema.notificationSubscription);
    const unsubscribe = new URL(await subscriptionUnsubscribeUrl(base, state.env.BETTER_AUTH_SECRET, subscription));
    const stopped = await call("POST", {
      action: "unsubscribe",
      id: subscription.id,
      token: unsubscribe.searchParams.get("token"),
    });
    expect(stopped.status).toBe(200);
    expect(((await stopped.json()) as { unsubscribed: boolean }).unsubscribed).toBe(true);
    expect((await state.db.select().from(schema.notificationSubscription))[0].unsubscribedAt).not.toBeNull();
  });
  it("accepts a 254-character address even with every character JSON-escaped", async () => {
    const address = `${"x".repeat(64)}@${"x".repeat(63)}.${"x".repeat(63)}.${"x".repeat(56)}.test`;
    expect(address.length).toBe(254);
    const escaped = [...address]
      .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join("");
    expect((await call("POST", `{"action":"request","email":"${escaped}"}`)).status).toBe(200);
    expect(state.sent[0].to).toBe(address);
  });
  it("uses the workspace's configured cloud hostname rather than client input for confirmation links", async () => {
    state.workspace = { id: "other" };
    state.env.ROOT_DOMAIN = "example.test";
    expect((await call("POST", { action: "request", email: "person@example.test" })).status).toBe(200);
    expect(new URL(state.sent[0].text.match(/https:\/\/\S+/)?.[0] ?? "").origin).toBe("https://other.example.test");
  });
  it("surfaces missing or uncertain sending as a safe failure", async () => {
    state.env.EMAIL = undefined;
    expect((await call("POST", { action: "request", email: "person@example.test" })).status).toBe(503);
    state.env.EMAIL = {
      async send() {
        throw new Error("person@example.test private-token");
      },
    };
    const response = await call("POST", { action: "request", email: "person@example.test" });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/person@example|private-token/);
  });
});
