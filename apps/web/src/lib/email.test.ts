// Notification mail contract (email-design.json): the invite message is captured
// at the real send seam — the EMAIL binding `send()` in sendEmail() — with
// user-controlled inviter/workspace names escaped and the shared design marker.
import { EMAIL_DESIGN_MARKER } from "@openheard/auth/email-template";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Sent = { to: string; from: { email: string; name: string }; subject: string; html: string; text: string };
const sent: Sent[] = [];
const testEnv = {
  EMAIL: {
    async send(m: Sent) {
      sent.push(m);
      return { messageId: `msg-${sent.length}` };
    },
  },
};
vi.mock("@openheard/env/server", () => ({ env: testEnv }));

import { renderInviteEmail, sendInviteEmail } from "./email";

beforeEach(() => {
  sent.length = 0;
});

describe("invite email", () => {
  it("is delivered through the EMAIL binding with the shared design and transport metadata intact", async () => {
    await sendInviteEmail("guest@example.test", "Ada", "Product Board", "https://feedback.example.test/join/abc");
    expect(sent).toHaveLength(1);
    const m = sent[0];
    if (!m) throw new Error("no message captured");
    expect(m.to).toBe("guest@example.test");
    expect(m.from).toEqual({ email: "hello@openheard.com", name: "openheard" });
    expect(m.subject).toBe("Ada invited you to Product Board");
    expect(m.html).toContain(EMAIL_DESIGN_MARKER);
    expect(m.html).toContain('role="presentation"');
    expect(m.html).toContain('href="https://feedback.example.test/join/abc"');
    expect(m.text).toContain("Accept invite: https://feedback.example.test/join/abc");
  });

  it("escapes a hostile inviter and workspace name and refuses a non-http join link (unsafe-interpolation control)", () => {
    const m = renderInviteEmail("<img src=x onerror=alert(1)>", 'Evil "</p><script>x</script>', "javascript:alert(1)");
    expect(m.html).toContain(EMAIL_DESIGN_MARKER);
    expect(m.html).not.toContain("<img src=x");
    expect(m.html).not.toContain("<script>");
    expect(m.html).not.toMatch(/href="javascript:/);
    expect(m.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    // Header-bound: the subject is flattened to one line so a name cannot inject a header.
    const folded = renderInviteEmail("A\r\nBcc: victim@example.test", "W", "https://x.test/j");
    expect(folded.subject).not.toMatch(/[\r\n]/);
    expect(folded.subject).toBe("A Bcc: victim@example.test invited you to W");
  });

  it("negative control: a message without the marker is not a designed message", () => {
    expect('<p>Join here: https://x.test/j</p>').not.toContain(EMAIL_DESIGN_MARKER);
  });
});
