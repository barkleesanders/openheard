import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  db: {},
  reset: vi.fn(),
  dispatch: vi.fn(),
  env: {
    EMAIL: { send: vi.fn() },
    BETTER_AUTH_SECRET: "fixture-secret-longer-than-32-characters",
    BETTER_AUTH_URL: "https://feedback.example.test",
    AUTH_EMAIL_FROM: "feedback@notifications.example.test",
    AUTH_EMAIL_FROM_NAME: "Fixture feedback",
  },
}));
vi.mock("@openheard/db", () => ({ createDb: () => state.db }));
vi.mock("@openheard/env/server", () => ({ env: state.env }));
vi.mock("./demo-db", () => ({ resetDemoWorkspace: state.reset }));
vi.mock("./notification-dispatch", () => ({ dispatchNotifications: state.dispatch }));
vi.mock("@tanstack/react-start/server", () => ({
  createStartHandler: () => async () => new Response("Fixture"),
  defaultStreamHandler: {},
}));

import worker from "../server";

beforeEach(() => {
  vi.clearAllMocks();
  state.reset.mockResolvedValue({ posts: 5 });
  state.dispatch.mockResolvedValue({ configured: true, accepted: 2 });
});
async function run(cron: string) {
  let scheduled: Promise<unknown> | undefined;
  await worker.scheduled({ cron } as ScheduledController, {}, {
    waitUntil(promise: Promise<unknown>) {
      scheduled = promise;
    },
  } as ExecutionContext);
  if (!scheduled) throw new Error("Worker did not register scheduled work");
  return scheduled;
}
describe("actual Worker scheduled entrypoint", () => {
  it("runs notification delivery on minute ticks without resetting the demo", async () => {
    await run("* * * * *");
    expect(state.reset).not.toHaveBeenCalled();
    expect(state.dispatch).toHaveBeenCalledWith(
      state.db,
      expect.objectContaining({
        mailer: state.env.EMAIL,
        secret: state.env.BETTER_AUTH_SECRET,
        origin: state.env.BETTER_AUTH_URL,
        from: { name: "Fixture feedback", email: "feedback@notifications.example.test" },
      }),
    );
  });
  it("retains nightly reset without firing delivery a second time", async () => {
    await run("0 4 * * *");
    expect(state.reset).toHaveBeenCalledWith(state.db);
    expect(state.dispatch).not.toHaveBeenCalled();
  });
  it("propagates scheduled failures and ignores unknown schedules", async () => {
    state.dispatch.mockRejectedValueOnce(new Error("Private fixture details"));
    await expect(run("* * * * *")).rejects.toThrow("Scheduled maintenance failed");
    await run("unknown");
    expect(state.dispatch).toHaveBeenCalledTimes(1);
    expect(state.reset).not.toHaveBeenCalled();
  });
});
