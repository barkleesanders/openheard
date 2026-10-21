import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: { role: "admin" } as { role: string } | null,
  send: vi.fn(async (_message: unknown) => ({ messageId: "test-message" })),
}));
vi.mock("./session", () => ({ getSessionContext: async () => ({ user: state.user }) }));
vi.mock("@openheard/env/server", () => ({
  env: {
    EMAIL: { send: state.send },
    AUTH_EMAIL_FROM: "help@example.test",
    AUTH_EMAIL_FROM_NAME: "Feedback",
  },
}));

import { emailTestHandlers, Route } from "../routes/api/email-test";

type Handler = (ctx: { request: Request }) => Promise<Response>;
const handlers: Record<string, Handler> = emailTestHandlers;
function call(method: string, origin?: string, body?: string) {
  const handler = handlers[method];
  if (!handler) throw new Error(`${method} handler missing`);
  return handler({
    request: new Request("https://feedback.example.test/api/email-test?to=unrequested@example.test", {
      method,
      headers: { ...(origin ? { Origin: origin } : {}), "Content-Type": "application/json" },
      ...(method === "POST" ? { body: body ?? JSON.stringify({ to: "test@example.test" }) } : {}),
    }),
  });
}

beforeEach(() => {
  state.user = { role: "admin" };
  state.send.mockClear();
});

describe("admin email diagnostics", () => {
  it("registers these exact handlers on the application route", () => {
    expect(Route.options.server?.handlers).toBe(emailTestHandlers);
  });
  it("never sends from a GET, even when an old recipient query parameter is present", async () => {
    const response = await call("GET");
    expect(response.status).toBe(200);
    expect(state.send).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
  it.each([undefined, "https://untrusted.example.test"])("rejects POST origin %s before sending", async (origin) => {
    expect((await call("POST", origin)).status).toBe(403);
    expect(state.send).not.toHaveBeenCalled();
  });
  it("requires an admin session", async () => {
    state.user = { role: "member" };
    expect((await call("POST", "https://feedback.example.test")).status).toBe(403);
    expect(state.send).not.toHaveBeenCalled();
  });
  it.each(["{", JSON.stringify({ to: "invalid" })])("rejects malformed recipient input", async (body) => {
    expect((await call("POST", "https://feedback.example.test", body)).status).toBe(400);
    expect(state.send).not.toHaveBeenCalled();
  });
  it("bounds input before parsing", async () => {
    expect((await call("POST", "https://feedback.example.test", "x".repeat(4096))).status).toBe(413);
    expect(state.send).not.toHaveBeenCalled();
  });
  it("accepts the maximum-length address even when every character is JSON-escaped", async () => {
    const address = `${"x".repeat(64)}@${"x".repeat(63)}.${"x".repeat(63)}.${"x".repeat(56)}.test`;
    expect(address).toHaveLength(254);
    const escaped = Array.from(address, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    expect((await call("POST", "https://feedback.example.test", `{"to":"${escaped}"}`)).status).toBe(200);
    expect(state.send).toHaveBeenCalledWith(expect.objectContaining({ to: address }));
  });
  it("uses the configured sender and shared design only after a same-origin POST", async () => {
    expect((await call("POST", "https://feedback.example.test")).status).toBe(200);
    expect(state.send).toHaveBeenCalledOnce();
    expect(state.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "test@example.test",
        from: { email: "help@example.test", name: "Feedback" },
        html: expect.stringContaining('data-email-design="editorial-v1"'),
      }),
    );
  });
});
