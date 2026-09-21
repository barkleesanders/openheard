import { createDb } from "@openheard/db";
import * as schema from "@openheard/db/schema/auth";
import { DEFAULT_STATUSES, membership, status, workspace } from "@openheard/db/schema/feedback";
import { env } from "@openheard/env/server";
import { betterAuth, type BetterAuthOptions, type SecondaryStorage } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { magicLink } from "better-auth/plugins";
import { magicLinkEmail, passwordResetEmail } from "./email-template";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { eq } from "drizzle-orm";

type KV = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl: number }): Promise<void>;
  delete(key: string): Promise<void>;
};

function createKvSecondaryStorage(store: KV): SecondaryStorage {
  return {
    async get(key: string) {
      const raw = await store.get(key);
      if (raw === null) return null;
      try { return JSON.parse(raw); } catch { return raw; }
    },
    async getAndDelete(key: string) {
      const raw = await store.get(key);
      if (raw !== null) await store.delete(key);
      if (raw === null) return null;
      try { return JSON.parse(raw); } catch { return raw; }
    },
    async increment(key: string, ttl: number) {
      const raw = await store.get(key);
      const next = (raw ? parseInt(raw, 10) : 0) + 1;
      await store.put(key, String(next), { expirationTtl: ttl });
      return next;
    },
    async set(key: string, value: string, ttl?: number) {
      await store.put(key, value, ttl ? { expirationTtl: ttl } : { expirationTtl: 3600 });
    },
    async delete(key: string) {
      await store.delete(key);
    },
  };
}

// Cloudflare Email Sending binding (alchemy.run.ts `Cloudflare.Email.SendEmail`).
// Sending from a domain the account has not enabled for Email Sending fails,
// so self-hosters set AUTH_EMAIL_FROM to an address on an enabled (sub)domain.
type AuthMailer = {
  send(message: { to: string; from: { email: string; name: string }; subject: string; html: string; text: string }): Promise<unknown>;
};

export const DEFAULT_AUTH_FROM = { email: "hello@openheard.com", name: "openheard" };

function authFrom(): { email: string; name: string } {
  const e = env as unknown as { AUTH_EMAIL_FROM?: string; AUTH_EMAIL_FROM_NAME?: string };
  const email = e.AUTH_EMAIL_FROM?.trim();
  if (!email) return DEFAULT_AUTH_FROM;
  return { email, name: e.AUTH_EMAIL_FROM_NAME?.trim() || DEFAULT_AUTH_FROM.name };
}

export type AuthEmailFlow = "reset_password" | "magic_link";

export class AuthEmailDeliveryError extends APIError {
  constructor() {
    super("SERVICE_UNAVAILABLE", {
      code: "AUTH_EMAIL_DELIVERY_FAILED",
      message: "Unable to send authentication email. Please try again shortly.",
    });
  }
}

// Request-scoped delivery outcome. createAuth() runs once per request
// (apps/web/src/routes/api/auth/$.ts), so this closure never outlives one.
//
// Better Auth 1.7.1 wraps every sender in runInBackgroundOrAwait
// (better-auth/dist/context/create-context.mjs), which catches and logs a
// rejected sender promise and lets the endpoint report success. A thrown
// error therefore never reaches the HTTP caller on its own: the sender records
// the failure here and the `hooks.after` middleware converts it into a
// generic, retryable 503 before any success or session signal leaves.
export function createAuthEmailDelivery(mailer: AuthMailer | undefined, from: { email: string; name: string }) {
  let failed = false;

  async function send(flow: AuthEmailFlow, to: string, subject: string, html: string, text: string) {
    if (!mailer) {
      // Local development has no Email binding: print the link/code so the
      // flow can be completed from the terminal.
      console.log(`[auth] ${subject} → ${to}\n  ${text.replace(/\n/g, "\n  ")}`);
      return;
    }
    try {
      const result = (await mailer.send({ to, from, subject, html, text })) as
        | { messageId?: string; success?: boolean; error?: unknown }
        | null
        | undefined;
      if (result && (result.success === false || result.error)) {
        throw new Error("mailer reported failure");
      }
      // Structured and PII-free: never the address, the link or the code.
      console.log(JSON.stringify({ event: "auth_email", flow, ok: true, messageId: result?.messageId ?? null }));
    } catch (err) {
      failed = true;
      const message = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ event: "auth_email", flow, ok: false, error: message.slice(0, 200) }));
      throw new AuthEmailDeliveryError();
    }
  }

  function assertDelivered() {
    if (failed) throw new AuthEmailDeliveryError();
  }

  return { send, assertDelivered };
}

// The demo workspace signs everyone into one shared account. Its cookies get
// their own name and stay host-only, so entering the demo cannot overwrite a
// real login that spans the root domain.
export const DEMO_COOKIE_PREFIX = "openheard-demo";

export function createAuth(opts?: { demo?: boolean }) {
  const db = createDb();
  // Browsers refuse Domain=localhost cookies, so cross-subdomain sessions only
  // apply on a real root domain. Locally you sign in per subdomain.
  const raw = (env as unknown as { ROOT_DOMAIN?: string }).ROOT_DOMAIN;
  const rootDomain = raw && raw !== "localhost" ? raw : undefined;

  const googleId = (env as unknown as { GOOGLE_CLIENT_ID?: string }).GOOGLE_CLIENT_ID;
  const googleSecret = (env as unknown as { GOOGLE_CLIENT_SECRET?: string }).GOOGLE_CLIENT_SECRET;

  const kvStore = (env as unknown as { CACHE?: KV }).CACHE;
  const from = authFrom();
  const delivery = createAuthEmailDelivery((env as unknown as { EMAIL?: AuthMailer }).EMAIL, from);

  const cookieAdvanced: NonNullable<BetterAuthOptions["advanced"]> = opts?.demo
    ? { cookiePrefix: DEMO_COOKIE_PREFIX }
    : rootDomain
      ? { crossSubDomainCookies: { enabled: true, domain: "." + rootDomain } }
      : {};

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: schema,
    }),
    secondaryStorage: kvStore ? createKvSecondaryStorage(kvStore) : undefined,
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      storage: kvStore ? "secondary-storage" : "memory",
      customRules: {
        "/sign-in/*": { window: 60, max: 5 },
        "/magic-link/*": { window: 60, max: 5 },
        "/sign-up/*": { window: 600, max: 3 },
      },
    },
    advanced: {
      ...cookieAdvanced,
      // Explicit so the Origin/CSRF gate behaves identically in tests and
      // production (Better Auth skips it under NODE_ENV=test when unset).
      disableOriginCheck: false,
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"],
      },
    },
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 300,
      },
    },
    trustedOrigins: [env.BETTER_AUTH_URL, ...(raw ? [`https://*.${raw}`, `http://*.${raw}`, `http://*.${raw}:*`] : [])],
    socialProviders: googleId && googleSecret ? { google: { clientId: googleId, clientSecret: googleSecret } } : {},
    emailAndPassword: {
      enabled: true,
      sendResetPassword: async ({ user, url }) => {
        const mail = passwordResetEmail(url, from.name);
        await delivery.send("reset_password", user.email, mail.subject, mail.html, mail.text);
      },
    },
    user: {
      additionalFields: {
        role: { type: "string", input: false, defaultValue: "member" },
      },
    },
    databaseHooks: {
      user: {
        create: {
          // Self-host: first account becomes admin. Cloud: always member.
          before: async (u) => {
            if (rootDomain) return { data: { ...u, role: "member" } };
            const existing = await db.select({ id: schema.user.id }).from(schema.user).limit(1);
            return { data: { ...u, role: existing.length === 0 ? "admin" : "member" } };
          },
          after: async (u) => {
            const [ws] = await db.select({ id: workspace.id }).from(workspace).where(eq(workspace.id, "default")).limit(1);
            if (!ws) {
              await db.insert(workspace).values({ id: "default" }).onConflictDoNothing();
              await db.insert(status).values(DEFAULT_STATUSES.map((d, i) => ({ workspaceId: "default", ...d, position: i }))).onConflictDoNothing();
            }
            const role = rootDomain
              ? "member" as const
              : (await db.select({ userId: membership.userId }).from(membership).where(eq(membership.workspaceId, "default")).limit(1)).length === 0
                ? "admin" as const
                : "member" as const;
            await db
              .insert(membership)
              .values({ workspaceId: "default", userId: u.id, role })
              .onConflictDoNothing();
          },
        },
      },
    },
    hooks: {
      after: createAuthMiddleware(async () => {
        // Surface a swallowed sender failure before the endpoint's success body.
        delivery.assertDelivered();
      }),
    },
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL || undefined,
    plugins: [
      tanstackStartCookies(),
      magicLink({
        // Only a hash of the emailed token is persisted; the verification row
        // cannot be replayed if the database leaks.
        storeToken: "hashed",
        sendMagicLink: async ({ email, url }, ctx?) => {
          let link = url;
          // Better Auth builds the link from baseURL (the apex). Rewrite the
          // origin to the workspace subdomain that actually made the request so
          // the verify redirect lands on the correct host.
          if (ctx?.request?.url) {
            const reqOrigin = new URL(ctx.request.url).origin;
            const baseOrigin = new URL(ctx.context.baseURL).origin;
            if (reqOrigin !== baseOrigin) {
              link = url.replace(baseOrigin, reqOrigin);
            }
          }
          const mail = magicLinkEmail(link, from.name);
          await delivery.send("magic_link", email, mail.subject, mail.html, mail.text);
        },
      }),
    ],
  });
}
