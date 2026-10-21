export type EmailSender = { email: string; name: string };
export type EmailMessage = {
  to: string;
  from: EmailSender;
  subject: string;
  html: string;
  text: string;
};
export type Mailer = { send(message: EmailMessage): Promise<unknown> };
export const DEFAULT_EMAIL_FROM: EmailSender = { email: "hello@openheard.com", name: "openheard" };

export function emailSender(env: { AUTH_EMAIL_FROM?: string; AUTH_EMAIL_FROM_NAME?: string }): EmailSender {
  return {
    email: env.AUTH_EMAIL_FROM?.trim() || DEFAULT_EMAIL_FROM.email,
    name: env.AUTH_EMAIL_FROM_NAME?.replace(/[\r\n\t]+/g, " ").trim() || DEFAULT_EMAIL_FROM.name,
  };
}

export class EmailDeliveryError extends Error {
  readonly code = "EMAIL_DELIVERY_FAILED";
  readonly status = 503;
  constructor(readonly outcome: "unavailable" | "unconfirmed") {
    super(
      outcome === "unavailable"
        ? "Email is unavailable. Please try again later."
        : "Email delivery could not be confirmed. Check before retrying.",
    );
  }
}

// Cloudflare's Email Sending binding resolves to EmailSendResult {messageId}.
// Primary client contract: @cloudflare/workers-types SendEmail / EmailSendResult.
// Acceptance is not proof of inbox delivery. Missing acknowledgements and thrown
// provider errors have uncertain outcomes: callers must not retry them blindly.
export async function deliverEmail(mailer: Mailer | undefined, message: EmailMessage): Promise<{ messageId: string }> {
  if (!mailer) throw new EmailDeliveryError("unavailable");
  try {
    const result = (await mailer.send(message)) as
      | { messageId?: unknown; success?: unknown; error?: unknown }
      | null
      | undefined;
    if (
      result?.success === false ||
      result?.error ||
      typeof result?.messageId !== "string" ||
      !result.messageId.trim()
    ) {
      throw new EmailDeliveryError("unconfirmed");
    }
    return { messageId: result.messageId };
  } catch {
    // Transport errors can contain recipient addresses, codes and invitation
    // URLs. Do not expose them through logs, causes or responses.
    throw new EmailDeliveryError("unconfirmed");
  }
}
