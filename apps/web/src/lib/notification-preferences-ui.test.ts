// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { type ComponentType, createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ save: vi.fn(), invalidate: vi.fn(), action: null as null | (() => unknown) }));
vi.mock("@/functions/settings", () => ({ getNotificationPrefs: vi.fn(), saveNotificationPrefs: state.save }));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useRouter: () => ({ invalidate: state.invalidate }),
}));
vi.mock("@/routes/dashboard/settings", () => ({ PageHead: () => null }));
vi.mock("@/components/admin/panel", () => ({
  SectionHead: () => null,
  Toggle: () => null,
  Row: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}));
vi.mock("@openheard/ui/components/interior/loading-button", () => ({
  LoadingButton: ({ onAction }: { onAction: () => unknown }) => {
    state.action = onAction;
    return null;
  },
}));

import { Route } from "../routes/dashboard/settings/notifications";

beforeEach(() => {
  vi.clearAllMocks();
  state.action = null;
  vi.spyOn(Route, "useLoaderData").mockReturnValue({ notifyNewPost: true, notifyComment: true, notifyStatus: false });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("notification preference save completion", () => {
  it("returns the real persistence promise and waits before invalidating the screen", async () => {
    let finish: (value: { ok: boolean }) => void = () => {};
    state.save.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(createElement(Route.options.component as ComponentType));
    const promise = state.action?.();
    expect(promise).toBeInstanceOf(Promise);
    let settled = false;
    void Promise.resolve(promise).then(() => {
      settled = true;
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(settled).toBe(false);
    expect(state.invalidate).not.toHaveBeenCalled();
    await act(async () => {
      finish({ ok: true });
      await promise;
    });
    expect(state.invalidate).toHaveBeenCalledTimes(1);
  });
  it("propagates persistence failure to the loading button instead of reporting success", async () => {
    state.save.mockRejectedValue(new Error("Fixture save failed"));
    render(createElement(Route.options.component as ComponentType));
    await expect(state.action?.()).rejects.toThrow("Fixture save failed");
    expect(state.invalidate).not.toHaveBeenCalled();
  });
});
