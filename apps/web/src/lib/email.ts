import { deliverEmail, emailSender, type Mailer } from "@openheard/auth/email-delivery";
import { type EditorialEmail, editorialEmailHtml, editorialEmailText } from "@openheard/auth/email-template";

// Notification mail (invites) shares the auth mail design in
// @openheard/auth/email-template: one template, one escaping path, one marker.
// Inviter and workspace names are user-controlled — they are escaped in HTML
// and never interpolated into a header-bound value beyond the subject line,
// which is flattened to a single line below.
const BRAND = "openheard";

function oneLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").trim();
}

export function renderInviteEmail(inviterName: string, workspaceName: string, joinUrl: string, brand = BRAND) {
  const inviter = oneLine(inviterName) || "Someone";
  const workspace = oneLine(workspaceName) || BRAND;
  const m: EditorialEmail = {
    brand,
    heading: "You've been invited",
    paragraphs: [`${inviter} invited you to join ${workspace} on ${brand}.`],
    cta: { label: "Accept invite", url: joinUrl },
    footer: "This invite link expires in 7 days.",
  };
  return {
    subject: `${inviter} invited you to ${workspace}`,
    html: editorialEmailHtml(m),
    text: editorialEmailText(m),
  };
}

export type { Mailer } from "@openheard/auth/email-delivery";

export async function sendEmail(to: string, subject: string, html: string, text: string) {
  const { env } = await import("@openheard/env/server");
  const config = env as unknown as { EMAIL?: Mailer; AUTH_EMAIL_FROM?: string; AUTH_EMAIL_FROM_NAME?: string };
  const result = await deliverEmail(config.EMAIL, { to, from: emailSender(config), subject, html, text });
  console.log(JSON.stringify({ event: "notification_email.accepted", messageId: result.messageId }));
  return result;
}

export async function sendInviteEmail(to: string, inviterName: string, workspaceName: string, joinUrl: string) {
  const { env } = await import("@openheard/env/server");
  const mail = renderInviteEmail(inviterName, workspaceName, joinUrl, emailSender(env).name);
  return sendEmail(to, mail.subject, mail.html, mail.text);
}
