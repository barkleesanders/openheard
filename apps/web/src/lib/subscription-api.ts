import { EmailDeliveryError, emailSender, type Mailer } from "@openheard/auth/email-delivery";
import { createDb } from "@openheard/db";
import { z } from "zod";
import { rateLimit } from "./rate-limit";
import { workspaceFromRequest } from "./session";
import {
  confirmEmailSubscription,
  requestEmailSubscription,
  subscriptionOrigin,
  subscriptionTokenHash,
  unsubscribeEmailSubscription,
} from "./subscriptions";

const Action = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("request"),
      email: z.string().trim().pipe(z.email().max(254)),
      postId: z.number().int().positive().optional(),
    })
    .strict(),
  z.object({ action: z.literal("confirm"), id: z.uuid(), token: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ action: z.literal("unsubscribe"), id: z.uuid(), token: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
const MAX_BODY_BYTES = 2048; // Covers the existing 254-character email contract, even JSON-escaped.
const SAFE_ERRORS = new Set([
  "Link is invalid or expired",
  "Post is not publicly available",
  "Email updates are unavailable here",
  "Invalid post",
]);
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
      ...extra,
    },
  });

async function environment() {
  const { env } = await import("@openheard/env/server");
  return env as unknown as {
    EMAIL?: Mailer;
    AUTH_EMAIL_FROM?: string;
    AUTH_EMAIL_FROM_NAME?: string;
    BETTER_AUTH_URL?: string;
    BETTER_AUTH_SECRET?: string;
    ROOT_DOMAIN?: string;
  };
}

async function bodyText(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new RangeError("Request too large");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function handleSubscriptionRequest(request: Request): Promise<Response> {
  if (request.method === "GET") {
    const env = await environment();
    return json({
      configured: Boolean(env.EMAIL && env.BETTER_AUTH_SECRET && env.BETTER_AUTH_SECRET.length >= 32),
      method: "POST",
      origin_required: true,
      actions: { request: ["email", "postId (optional)"], confirm: ["id", "token"], unsubscribe: ["id", "token"] },
    });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, { Allow: "GET, POST" });
  if (request.headers.get("Origin") !== new URL(request.url).origin)
    return json({ error: "Same-origin request required" }, 403);
  if (request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
    return json({ error: "JSON body required" }, 415);
  let input: z.infer<typeof Action>;
  try {
    input = Action.parse(JSON.parse(await bodyText(request)));
  } catch (error) {
    return json(
      { error: error instanceof RangeError ? "Request too large" : "Invalid update request" },
      error instanceof RangeError ? 413 : 400,
    );
  }
  const ws = await workspaceFromRequest(request);
  if (!ws) return json({ error: "Workspace not found" }, 404);
  const ip = await subscriptionTokenHash(request.headers.get("CF-Connecting-IP") ?? "local");
  const limit = await rateLimit(`email-updates:${ws.id}:${input.action}:${ip}`, {
    max: input.action === "request" ? 5 : 30,
    window: input.action === "request" ? 600 : 60,
    failClosed: true,
  });
  if (!limit.allowed) return json({ error: "Too many requests" }, 429, { "Retry-After": String(limit.retryAfter) });
  try {
    const db = createDb();
    const env = await environment();
    if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) throw new EmailDeliveryError("unavailable");
    if (input.action === "confirm")
      return json({ ok: true, ...(await confirmEmailSubscription(db, ws.id, input.id, input.token)) });
    if (input.action === "unsubscribe")
      return json({
        ok: true,
        ...(await unsubscribeEmailSubscription(db, ws.id, input.id, input.token, env.BETTER_AUTH_SECRET)),
      });
    let origin = subscriptionOrigin(env.BETTER_AUTH_URL || "");
    const root = env.ROOT_DOMAIN?.trim().toLowerCase();
    if (root && root !== "localhost" && ws.id !== "default") {
      if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(ws.id) || !/^[a-z0-9.-]+$/.test(root))
        throw new EmailDeliveryError("unavailable");
      origin = subscriptionOrigin(`https://${ws.id}.${root}`);
    }
    const from = emailSender(env);
    return json({
      ok: true,
      ...(await requestEmailSubscription(db, ws.id, input, { origin, brand: from.name, from, mailer: env.EMAIL })),
    });
  } catch (error) {
    if (error instanceof EmailDeliveryError) return json({ error: error.message }, 503);
    if (error instanceof Error && SAFE_ERRORS.has(error.message)) return json({ error: error.message }, 400);
    console.error(JSON.stringify({ event: "email_updates.failed" }));
    return json({ error: "Email updates are temporarily unavailable" }, 503);
  }
}
