import { editorialEmailHtml, editorialEmailText } from "@openheard/auth/email-template";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import type { Mailer } from "@/lib/email";
import { getSessionContext } from "@/lib/session";

const Recipient = z.object({ to: z.email().max(254) }).strict();
// The schema permits one address of at most 254 characters. Even escaping
// every character as six JSON bytes takes 1533 bytes; 2 KiB covers that
// representation plus whitespace. Count streamed bytes before parsing.
const MAX_BODY_BYTES = 2048;

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

async function readBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new RangeError("Request too large");
    }
    text += decoder.decode(value, { stream: true });
  }
}

async function mailEnvironment() {
  const { env } = await import("@openheard/env/server");
  return env as unknown as { EMAIL?: Mailer; AUTH_EMAIL_FROM?: string; AUTH_EMAIL_FROM_NAME?: string };
}

export const Route = createFileRoute("/api/email-test")({
  server: {
    handlers: {
      // A link, crawler or prefetched URL must never send a message.
      GET: async ({ request }: { request: Request }) => {
        const { user } = await getSessionContext(request);
        if (user?.role !== "admin") return json({ error: "admin session required" }, 403);
        const env = await mailEnvironment();
        return json({ configured: !!env.EMAIL, send_method: "POST" });
      },
      POST: async ({ request }: { request: Request }) => {
        const { user } = await getSessionContext(request);
        if (user?.role !== "admin") return json({ error: "admin session required" }, 403);
        if (request.headers.get("Origin") !== new URL(request.url).origin) {
          return json({ error: "same-origin request required" }, 403);
        }
        if (request.headers.get("Content-Type")?.split(";")[0]?.trim() !== "application/json") {
          return json({ error: "JSON body required" }, 415);
        }
        let to: string;
        try {
          to = Recipient.parse(JSON.parse(await readBody(request))).to;
        } catch (error) {
          return json(
            { error: error instanceof RangeError ? "request too large" : "invalid recipient" },
            error instanceof RangeError ? 413 : 400,
          );
        }
        const env = await mailEnvironment();
        if (!env.EMAIL) return json({ error: "email binding unavailable" }, 503);
        const brand = env.AUTH_EMAIL_FROM_NAME || "openheard";
        const message = {
          brand,
          heading: "Email delivery test",
          paragraphs: ["This message verifies the feedback board's email sending configuration."],
        };
        try {
          await env.EMAIL.send({
            to,
            from: { email: env.AUTH_EMAIL_FROM || "hello@openheard.com", name: brand },
            subject: "Feedback board email test",
            text: editorialEmailText(message),
            html: editorialEmailHtml(message),
          });
          console.log(JSON.stringify({ event: "email_test.accepted" }));
          return json({ ok: true });
        } catch (error) {
          const reason = (error instanceof Error ? error.message : String(error))
            .replace(/[^\s@]+@[^\s@]+/g, "[email]")
            .slice(0, 300);
          console.error(JSON.stringify({ event: "email_test.failed", reason }));
          return json({ error: "send failed" }, 502);
        }
      },
    },
  },
});
