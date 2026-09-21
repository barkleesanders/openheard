import { editorialEmailHtml, editorialEmailText, type EditorialEmail } from "@openheard/auth/email-template";

// Notification mail (invites) shares the auth mail design in
// @openheard/auth/email-template: one template, one escaping path, one marker.
// Inviter and workspace names are user-controlled — they are escaped in HTML
// and never interpolated into a header-bound value beyond the subject line,
// which is flattened to a single line below.
const FROM = { email: "hello@openheard.com", name: "openheard" };
const BRAND = "openheard";

function oneLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").trim();
}

export function renderInviteEmail(inviterName: string, workspaceName: string, joinUrl: string) {
  const inviter = oneLine(inviterName) || "Someone";
  const workspace = oneLine(workspaceName) || BRAND;
  const m: EditorialEmail = {
    brand: BRAND,
    heading: "You've been invited",
    paragraphs: [`${inviter} invited you to join ${workspace} on ${BRAND}.`],
    cta: { label: "Accept invite", url: joinUrl },
    footer: "This invite link expires in 7 days.",
  };
  return { subject: `${inviter} invited you to ${workspace}`, html: editorialEmailHtml(m), text: editorialEmailText(m) };
}

type Mailer = {
  send(message: { to: string; from: { email: string; name: string }; subject: string; html: string; text: string }): Promise<{ messageId?: string } | null | undefined>;
};

export async function sendEmail(to: string, subject: string, html: string, text: string) {
  try {
    const { env } = await import("@openheard/env/server");
    const mailer = (env as unknown as { EMAIL?: Mailer }).EMAIL;
    if (!mailer) {
      console.log(`[email] No EMAIL binding — logging instead\n  To: ${to}\n  Subject: ${subject}\n  ${text.replace(/\n/g, "\n  ")}`);
      return;
    }
    const result = await mailer.send({ to, from: FROM, subject, html, text });
    console.log(`[email] sent: ${subject} → ${to}`, result?.messageId ?? "");
  } catch (err) {
    console.error("[email] send failed:", err instanceof Error ? err.message : String(err));
  }
}

export async function sendInviteEmail(to: string, inviterName: string, workspaceName: string, joinUrl: string) {
  const mail = renderInviteEmail(inviterName, workspaceName, joinUrl);
  await sendEmail(to, mail.subject, mail.html, mail.text);
}
