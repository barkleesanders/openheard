// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubscriptionAction, SubscriptionForm } from "../components/subscription-form";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const success = () => Response.json({ ok: true, requested: true, confirmed: true, unsubscribed: true });
const id = "12345678-1234-4234-8234-123456789012";
const token = "a".repeat(64);

describe("subscription screens", () => {
  it("submits the displayed email and post scope once despite two synchronous submissions", async () => {
    let resolve: (value: Response) => void = () => {};
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const { container } = render(createElement(SubscriptionForm, { postId: 12 }));
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "person@example.test" } });
    const form = container.querySelector("form");
    if (!form) throw new Error("Subscription form missing");
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toEqual([
      "/api/updates",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "request", email: "person@example.test", postId: 12 }),
        credentials: "same-origin",
        referrerPolicy: "no-referrer",
      },
    ]);
    resolve(success());
    await waitFor(() => expect(screen.getByRole("button").textContent).toBe("Request received"));
    expect(screen.getByRole("status").textContent).toContain("If confirmation is needed");
    fireEvent.submit(form);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps an unsuccessful request retryable without claiming a subscription", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: "unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(success());
    vi.stubGlobal("fetch", fetcher);
    const { container } = render(createElement(SubscriptionForm));
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "person@example.test" } });
    const form = container.querySelector("form");
    if (!form) throw new Error("Subscription form missing");
    fireEvent.submit(form);
    await screen.findByRole("alert");
    expect(screen.getByRole("button").hasAttribute("disabled")).toBe(false);
    fireEvent.submit(form);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    await waitFor(() => expect(screen.getByRole("button").textContent).toBe("Request received"));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["confirm", "unsubscribe"])("requires an explicit %s action and holds its success lock", async (mode) => {
    const fetcher = vi.fn().mockResolvedValue(success());
    vi.stubGlobal("fetch", fetcher);
    render(createElement(SubscriptionAction, { mode, id, token }));
    expect(fetcher).not.toHaveBeenCalled();
    const button = screen.getByRole("button");
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitFor(() => expect(button.textContent).toBe("Updated"));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ action: mode, id, token });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("status").textContent).toContain(mode === "confirm" ? "confirmed" : "unsubscribed");
  });

  it("does not act on incomplete links or claim success after an expired link", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ error: "Link is invalid or expired" }, { status: 400 }));
    vi.stubGlobal("fetch", fetcher);
    const view = render(createElement(SubscriptionAction, { mode: "confirm", id, token: "" }));
    expect(screen.queryByRole("button")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    view.rerender(createElement(SubscriptionAction, { mode: "confirm", id, token }));
    fireEvent.click(screen.getByRole("button"));
    await screen.findByRole("alert");
    expect(screen.getByRole("status").textContent).not.toContain("is confirmed");
    expect(screen.getByRole("button").hasAttribute("disabled")).toBe(false);
  });
});
