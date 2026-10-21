import { describe, expect, it, vi } from "vitest";
import { deliverEmail, EmailDeliveryError, emailSender } from "./email-delivery";

const message = {
  to: "guest@example.test",
  from: { email: "feedback@example.test", name: "Example Feedback" },
  subject: "Fixture",
  html: "<p>Fixture</p>",
  text: "Fixture",
};

describe("Cloudflare Email Sending result contract", () => {
  it("preserves a real provider acceptance ID without calling it inbox delivery", async () => {
    const send = vi.fn(async () => ({ messageId: "fixture-message" }));
    expect(await deliverEmail({ send }, message)).toEqual({ messageId: "fixture-message" });
    expect(send).toHaveBeenCalledExactlyOnceWith(message);
  });
  for (const result of [
    undefined,
    null,
    {},
    { messageId: "" },
    { messageId: 1 },
    { success: false, messageId: "misleading" },
    { messageId: "misleading", error: "private-token guest@example.test" },
  ]) {
    it(`treats invalid acknowledgement ${JSON.stringify(result)} as an unconfirmed outcome`, async () => {
      await expect(deliverEmail({ send: async () => result }, message)).rejects.toMatchObject({
        code: "EMAIL_DELIVERY_FAILED",
        outcome: "unconfirmed",
      });
    });
  }
  it("distinguishes no attempt from uncertain transport outcomes and drops private provider errors", async () => {
    await expect(deliverEmail(undefined, message)).rejects.toMatchObject({ outcome: "unavailable" });
    try {
      await deliverEmail(
        {
          send: async () => {
            throw new Error("private-token guest@example.test");
          },
        },
        message,
      );
      expect.fail("transport failure must reject");
    } catch (error) {
      expect(error).toBeInstanceOf(EmailDeliveryError);
      expect(String(error)).not.toMatch(/private-token|guest@example/);
      expect(error).not.toHaveProperty("cause");
    }
  });
  it("uses the configured site sender and flattens display-name header breaks", () => {
    expect(
      emailSender({ AUTH_EMAIL_FROM: " feedback@example.test ", AUTH_EMAIL_FROM_NAME: "Example\r\nFeedback" }),
    ).toEqual({ email: "feedback@example.test", name: "Example Feedback" });
    expect(emailSender({})).toEqual({ email: "hello@openheard.com", name: "openheard" });
  });
});
