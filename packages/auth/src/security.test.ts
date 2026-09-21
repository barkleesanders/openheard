// Better Auth security contract for openheard (docs/self-host-improve-network.md,
// betterauth.security.json). Every test drives the production `createAuth()`
// handler from ./index.ts over real HTTP Requests against a fresh in-memory
// schema — the same code path apps/web/src/routes/api/auth/$.ts forwards to.
import { createClient } from "@libsql/client";
import type { Db } from "@openheard/db";
import * as schema from "@openheard/db/schema/index";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const MIGRATIONS = new URL("../../db/migrations/", import.meta.url).pathname;
const BASE = "http://localhost:3001";

async function freshDb(): Promise<Db> {
  const client = createClient({ url: ":memory:" });
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    await client.executeMultiple(readFileSync(MIGRATIONS + file, "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  await client.execute("PRAGMA foreign_keys = ON");
  return drizzle(client, { schema }) as unknown as Db;
}

type Sent = { to: string; from: { email: string; name: string }; subject: string; text: string };
const mailer = {
  sent: [] as Sent[],
  fail: false,
  async send(message: Sent) {
    if (mailer.fail) throw new Error("provider rejected (simulated outage)");
    mailer.sent.push(message);
    return { messageId: `msg-${mailer.sent.length}` };
  },
};

// Better Auth keys rate-limit buckets by client IP and its memory store lives
// for the whole process, so each test gets its own address.
let clientIp = "203.0.113.1";
let ipCounter = 1;

const testEnv = {
  DB: undefined as undefined,
  DB_LOCAL: undefined as Db | undefined,
  CACHE: undefined as undefined,
  EMAIL: mailer as unknown as undefined,
  BETTER_AUTH_URL: BASE,
  BETTER_AUTH_SECRET: "test-secret-not-a-real-one-32chars",
  ROOT_DOMAIN: "",
  AUTH_EMAIL_FROM: "feedback@notifications.example.test",
  AUTH_EMAIL_FROM_NAME: "Example Feedback",
};
vi.mock("@openheard/env/server", () => ({ env: testEnv }));

type Auth = ReturnType<typeof import("./index")["createAuth"]>;
let createAuth: typeof import("./index")["createAuth"];

beforeEach(async () => {
  testEnv.DB_LOCAL = await freshDb();
  mailer.sent = [];
  mailer.fail = false;
  clientIp = `203.0.113.${++ipCounter}`;
  ({ createAuth } = await import("./index"));
});

function post(auth: Auth, path: string, body: unknown, headers: Record<string, string> = {}) {
  return auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, "x-forwarded-for": clientIp, ...headers },
      body: JSON.stringify(body),
    }),
  );
}
function get(auth: Auth, path: string, headers: Record<string, string> = {}) {
  return auth.handler(new Request(`${BASE}/api/auth${path}`, { method: "GET", headers: { "x-forwarded-for": clientIp, ...headers } }));
}
function cookiesOf(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1);
  }
  return out;
}
const USER = { email: "first@example.test", password: "correct horse battery staple", name: "First" };
async function signUp(auth: Auth) {
  const res = await post(auth, "/sign-up/email", USER);
  expect(res.status).toBe(200);
  return cookiesOf(res);
}

describe("email delivery failures reach the HTTP caller", () => {
  it("password reset request returns a generic 503 when the mailer fails", async () => {
    const auth = createAuth();
    await signUp(auth);
    mailer.fail = true;
    const res = await post(createAuth(), "/request-password-reset", { email: USER.email, redirectTo: "/reset" });
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toContain("AUTH_EMAIL_DELIVERY_FAILED");
    expect(text).not.toMatch(/simulated outage|provider|token=|first@example/);
  });

  it("password reset request succeeds and sends from the configured address when the mailer works", async () => {
    await signUp(createAuth());
    const res = await post(createAuth(), "/request-password-reset", { email: USER.email, redirectTo: "/reset" });
    expect(res.status).toBe(200);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.from).toEqual({ email: "feedback@notifications.example.test", name: "Example Feedback" });
    expect(mailer.sent[0]?.text).toContain("/api/auth/reset-password/");
  });

  it("magic link request returns a generic 503 when the mailer fails", async () => {
    mailer.fail = true;
    const res = await post(createAuth(), "/sign-in/magic-link", { email: USER.email, callbackURL: "/" });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("AUTH_EMAIL_DELIVERY_FAILED");
  });

  it("a failed request does not poison the next request", async () => {
    mailer.fail = true;
    expect((await post(createAuth(), "/sign-in/magic-link", { email: USER.email, callbackURL: "/" })).status).toBe(503);
    mailer.fail = false;
    expect((await post(createAuth(), "/sign-in/magic-link", { email: USER.email, callbackURL: "/" })).status).toBe(200);
  });
});

describe("magic link storage", () => {
  it("persists only a hash of the emailed token and redeems it exactly once", async () => {
    const res = await post(createAuth(), "/sign-in/magic-link", { email: USER.email, callbackURL: "/welcome" });
    expect(res.status).toBe(200);
    const url = new URL(mailer.sent[0]?.text.match(/https?:\/\/\S+/)?.[0] ?? "");
    const token = url.searchParams.get("token");
    expect(token).toBeTruthy();
    const rows = await testEnv.DB_LOCAL!.select().from(schema.verification);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.identifier).not.toBe(token);
      expect(row.identifier).not.toContain(token!);
      expect(row.value).not.toContain(token!);
    }
    const first = await get(createAuth(), `/magic-link/verify?token=${token}&callbackURL=/welcome`);
    expect([200, 302]).toContain(first.status);
    expect(cookiesOf(first)["better-auth.session_token"]).toBeTruthy();
    const second = await get(createAuth(), `/magic-link/verify?token=${token}&callbackURL=/welcome`);
    expect(cookiesOf(second)["better-auth.session_token"] ?? "").toBe("");
  });
});

describe("sessions", () => {
  it("sign-out revokes the session in the database, not only the cookie", async () => {
    const auth = createAuth();
    const cookies = await signUp(auth);
    const token = cookies["better-auth.session_token"];
    expect(token).toBeTruthy();
    const cookie = `better-auth.session_token=${token}`;
    const before = await get(createAuth(), "/get-session", { cookie });
    expect((await before.json()) as unknown).not.toBeNull();
    const out = await post(createAuth(), "/sign-out", {}, { cookie });
    expect(out.status).toBe(200);
    const after = await get(createAuth(), "/get-session", { cookie });
    expect(await after.json()).toBeNull();
  });

  it("caches the session in a signed cookie for at most five minutes", async () => {
    const cookies = await signUp(createAuth());
    const res = await get(createAuth(), "/get-session", { cookie: `better-auth.session_token=${cookies["better-auth.session_token"]}` });
    const line = res.headers.getSetCookie().find((l) => l.startsWith("better-auth.session_data="));
    expect(line).toBeTruthy();
    const maxAge = Number(/Max-Age=(\d+)/i.exec(line!)?.[1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(300);
  });

  it("rate limits password sign-in attempts within one instance", async () => {
    const auth = createAuth();
    await signUp(auth);
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await post(auth, "/sign-in/email", { email: USER.email, password: "wrong-password-attempt" });
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
  });
});

describe("origins and disabled methods", () => {
  it("rejects a sign-out from an untrusted origin", async () => {
    const auth = createAuth();
    const cookies = await signUp(auth);
    const cookie = `better-auth.session_token=${cookies["better-auth.session_token"]}`;
    const res = await post(createAuth(), "/sign-out", {}, { cookie, origin: "https://attacker.invalid" });
    expect(res.status).toBe(403);
    const still = await get(createAuth(), "/get-session", { cookie });
    expect(await still.json()).not.toBeNull();
  });

  it("exposes no OTP, two-factor or passkey routes", async () => {
    const auth = createAuth();
    for (const path of ["/email-otp/send-verification-otp", "/two-factor/enable", "/passkey/generate-register-options"]) {
      const res = await post(auth, path, { email: USER.email });
      expect(res.status, path).toBe(404);
    }
  });
});
