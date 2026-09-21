// Branded email contract (email-design.json). The auth mail is captured at the
// real send seam — the EMAIL binding `send()` that createAuth() calls — by
// driving the production handler over HTTP, exactly like security.test.ts.
import { createClient } from "@libsql/client";
import type { Db } from "@openheard/db";
import * as schema from "@openheard/db/schema/index";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMAIL_DESIGN_MARKER, EMAIL_TOKENS, editorialEmailHtml, escapeHtml, isSafeHref } from "./email-template";

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

type Sent = { to: string; from: { email: string; name: string }; subject: string; html: string; text: string };
const mailer = {
  sent: [] as Sent[],
  async send(message: Sent) {
    mailer.sent.push(message);
    return { messageId: `msg-${mailer.sent.length}` };
  },
};
let clientIp = "203.0.113.100";
let ipCounter = 100;

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
  clientIp = `203.0.113.${++ipCounter}`;
  ({ createAuth } = await import("./index"));
});

function post(auth: Auth, path: string, body: unknown) {
  return auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, "x-forwarded-for": clientIp },
      body: JSON.stringify(body),
    }),
  );
}

// The contract every final message must satisfy. Kept as one function so the
// negative controls below prove the check itself can fail.
function assertDesigned(m: Sent) {
  expect(m.html).toContain(EMAIL_DESIGN_MARKER);
  expect(m.html).toContain('role="presentation"');
  expect(m.html).toContain(EMAIL_TOKENS.paper);
  expect(m.html).toContain(EMAIL_TOKENS.ink);
  expect(m.html).toMatch(/max-width:560px/);
  expect(m.html).not.toMatch(/<script|onerror=|javascript:/i);
  expect(m.text.length).toBeGreaterThan(20);
}

describe("auth mail carries the shared editorial design at the send seam", () => {
  it("magic link", async () => {
    const res = await post(createAuth(), "/sign-in/magic-link", { email: "new@example.test", callbackURL: "/" });
    expect(res.status).toBe(200);
    expect(mailer.sent).toHaveLength(1);
    const m = mailer.sent[0];
    if (!m) throw new Error("no message captured");
    assertDesigned(m);
    expect(m.subject).toBe("Your sign-in link");
    expect(m.from).toEqual({ email: "feedback@notifications.example.test", name: "Example Feedback" });
    expect(m.html).toContain("Sign in to Example Feedback");
    const link = m.text.match(/https?:\/\/\S+/)?.[0];
    expect(link).toContain("/api/auth/magic-link/verify");
    expect(m.html).toContain(`href="${escapeHtml(link ?? "")}"`);
  });

  it("password reset", async () => {
    const auth = createAuth();
    const user = { email: "first@example.test", password: "correct horse battery staple", name: "First" };
    expect((await post(auth, "/sign-up/email", user)).status).toBe(200);
    const res = await post(createAuth(), "/request-password-reset", { email: user.email, redirectTo: "/reset" });
    expect(res.status).toBe(200);
    // sign-up may send nothing; the reset request must send exactly one message
    const m = mailer.sent.at(-1);
    if (!m) throw new Error("no message captured");
    assertDesigned(m);
    expect(m.subject).toBe("Reset your password");
    expect(m.text).toContain("/api/auth/reset-password/");
  });
});

describe("template escaping (unsafe-interpolation controls)", () => {
  it("escapes untrusted text and never renders a non-http link as an anchor", () => {
    const html = editorialEmailHtml({
      brand: "<b>evil</b>",
      heading: '"><script>alert(1)</script>',
      paragraphs: ["<img src=x onerror=alert(1)>"],
      cta: { label: "Go", url: "javascript:alert(1)" },
    });
    expect(html).toContain(EMAIL_DESIGN_MARKER);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>evil");
    expect(html).not.toMatch(/href="javascript:/);
    expect(html).toContain("&lt;script&gt;");
  });

  it("http(s) links are the only anchors; the href itself is attribute-escaped", () => {
    const url = 'https://example.test/verify?token=abc"><script>x</script>';
    const html = editorialEmailHtml({ brand: "b", heading: "h", paragraphs: [], cta: { label: "Go", url } });
    expect(html).not.toContain("<script>");
    expect(html).toContain(`href="${escapeHtml(url)}"`);
    expect(isSafeHref("https://a.test/x")).toBe(true);
    expect(isSafeHref("data:text/html,x")).toBe(false);
    expect(isSafeHref("not a url")).toBe(false);
  });

  it("negative control: the legacy bare-<p> template fails the design contract", () => {
    const legacy: Sent = {
      to: "x@example.test",
      from: { email: "a@b.test", name: "n" },
      subject: "Your sign-in link",
      html: '<p>Click to sign in.</p><p><a href="https://x.test/l">https://x.test/l</a></p>',
      text: "Sign in: https://x.test/l",
    };
    expect(() => assertDesigned(legacy)).toThrow();
  });
});
