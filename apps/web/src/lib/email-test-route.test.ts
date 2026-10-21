import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: { role: "admin" } as { role: string } | null,
  send: vi.fn(async (_message: unknown): Promise<unknown> => ({ messageId: "test-message" })),
}));
vi.mock("./session", () => ({ getSessionContext: async () => ({ user: state.user }) }));
vi.mock("@openheard/env/server", () => ({
  env: {
    EMAIL: { send: state.send },
    AUTH_EMAIL_FROM: "help@example.test",
    AUTH_EMAIL_FROM_NAME: "Feedback",
  },
}));

import { Route } from "../routes/api/email-test";

const handlers = Route.options.server?.handlers;
if (!handlers || typeof handlers !== "object") throw new Error("Email diagnostic route handlers missing");
function call(method: "GET" | "POST", origin?: string, body?: string) {
  const registered = Route.options.server?.handlers;
  if (!registered || typeof registered !== "object") throw new Error("Route handlers missing");
  const value: unknown = Reflect.get(registered, method);
  if (typeof value !== "function") throw new Error(`${method} handler missing`);
  // Test adapter for the framework's registered request-handler contract.
  const handler = value as (ctx: { request: Request }) => Promise<Response>;
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
    expect(Object.keys(handlers)).toEqual(["GET", "POST"]);
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
  it.each([undefined, { success: false, error: "private-token test@example.test" }])(
    "does not report success for an invalid provider acknowledgement",
    async (result) => {
      state.send.mockResolvedValueOnce(result);
      const response = await call("POST", "https://feedback.example.test");
      expect(response.status).toBe(502);
      expect(await response.text()).not.toMatch(/private-token|test@example/);
    },
  );
});
