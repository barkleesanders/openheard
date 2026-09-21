// Shared editorial email design for every openheard message (auth mail here,
// notification mail in apps/web/src/lib/email.ts). One template, one escaping
// path, one marker the email-design gate can assert on at the real send seam.
//
// Tokens mirror packages/ui/src/styles/globals.css (light theme): paper
// --background #f7f5f0, ink --foreground #141416, accent --primary #141416,
// rule --border #e3e0d8, card #ffffff. Geist is the site face; mail clients
// fall back down the stack.
export const EMAIL_DESIGN_MARKER = 'data-email-design="editorial-v1"';

export const EMAIL_TOKENS = {
  paper: "#f7f5f0",
  ink: "#141416",
  accent: "#141416",
  muted: "#5b5b63",
  rule: "#e3e0d8",
  card: "#ffffff",
} as const;

const FONT = 'font-family: Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;';

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Only http(s) links may become anchors; anything else is shown as plain text
// so a crafted value can never yield a javascript:/data: href.
export function isSafeHref(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export interface EditorialEmail {
  brand: string;
  heading: string;
  /** Plain-text paragraphs; escaped here, never pre-formatted HTML. */
  paragraphs: string[];
  cta?: { label: string; url: string };
  footer?: string;
}

function paragraph(text: string, color: string, size = 15): string {
  return `<p style="${FONT} font-size:${size}px; line-height:1.7; color:${color}; margin:0 0 14px;">${escapeHtml(text)}</p>`;
}

export function editorialEmailHtml(m: EditorialEmail): string {
  const t = EMAIL_TOKENS;
  const cta = m.cta
    ? isSafeHref(m.cta.url)
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 18px;"><tr><td style="background:${t.accent}; border-radius:8px;">
      <a href="${escapeHtml(m.cta.url)}" style="display:inline-block; padding:12px 26px; color:#ffffff; text-decoration:none; ${FONT} font-size:14px; font-weight:600;">${escapeHtml(m.cta.label)}</a>
    </td></tr></table>
    <p style="${FONT} font-size:12px; line-height:1.6; color:${t.muted}; margin:0 0 14px; word-break:break-all;">${escapeHtml(m.cta.url)}</p>`
      : paragraph(m.cta.url, t.muted, 13)
    : "";
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${escapeHtml(m.heading)}</title></head>
<body style="margin:0; padding:0; background:${t.paper};">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" ${EMAIL_DESIGN_MARKER} style="background:${t.paper};">
    <tr><td align="center" style="padding:40px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;">
        <tr><td style="${FONT} font-size:15px; font-weight:700; color:${t.ink}; letter-spacing:-0.2px; padding:0 4px 18px;">${escapeHtml(m.brand)}</td></tr>
        <tr><td style="background:${t.card}; border:1px solid ${t.rule}; border-radius:12px; padding:34px 32px;">
          <h1 style="${FONT} font-size:21px; line-height:1.3; font-weight:700; color:${t.ink}; margin:0 0 16px;">${escapeHtml(m.heading)}</h1>
          ${m.paragraphs.map((p) => paragraph(p, t.ink)).join("\n          ")}
          ${cta}
          ${m.footer ? paragraph(m.footer, t.muted, 13) : ""}
        </td></tr>
        <tr><td align="center" style="${FONT} font-size:11px; line-height:1.6; color:${t.muted}; padding:22px 4px 0;">${escapeHtml(m.brand)} &middot; open source feedback board</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function editorialEmailText(m: EditorialEmail): string {
  const lines = [m.heading, "", ...m.paragraphs];
  if (m.cta) lines.push("", `${m.cta.label}: ${m.cta.url}`);
  if (m.footer) lines.push("", m.footer);
  return lines.join("\n");
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function magicLinkEmail(link: string, brand: string): RenderedEmail {
  const m: EditorialEmail = {
    brand,
    heading: `Sign in to ${brand}`,
    paragraphs: ["Use the button below to sign in. This link expires in 5 minutes."],
    cta: { label: "Sign in", url: link },
    footer: "If you didn't request this, you can safely ignore this email.",
  };
  return { subject: "Your sign-in link", html: editorialEmailHtml(m), text: editorialEmailText(m) };
}

export function passwordResetEmail(url: string, brand: string): RenderedEmail {
  const m: EditorialEmail = {
    brand,
    heading: "Reset your password",
    paragraphs: ["Use the button below to set a new password. This link expires in 1 hour."],
    cta: { label: "Reset password", url },
    footer: "If you didn't request this, you can safely ignore this email.",
  };
  return { subject: "Reset your password", html: editorialEmailHtml(m), text: editorialEmailText(m) };
}
