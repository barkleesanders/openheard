// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type ComponentType, createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const router = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...router,
    useLoaderData: () => ({ user: null, boards: [], tags: [], statuses: [], statusCounts: {} }),
    useRouter: () => ({ invalidate: vi.fn() }),
    useNavigate: () => navigation.navigate,
    Link: ({ to, children, className }: { to: string; children?: React.ReactNode; className?: string }) =>
      createElement("a", { href: to, className }, children),
  };
});
vi.mock("@/functions/settings", () => ({
  deleteBoard: vi.fn(),
  deleteTag: vi.fn(),
  saveBoard: vi.fn(),
  saveTag: vi.fn(),
}));
vi.mock("@/functions/statuses", () => ({
  deleteStatus: vi.fn(),
  reorderStatuses: vi.fn(),
  saveStatus: vi.fn(),
}));

import { Panel } from "../components/admin/panel";
import { GITHUB, Nav } from "../components/landing/top";
import { Route as BoardsRoute } from "../routes/dashboard/settings/boards";
import { Route as StatusesRoute } from "../routes/dashboard/settings/statuses";

// jsdom has no scrolling implementation; navigation is observed separately below.
Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });

afterEach(cleanup);

describe("admin panel navigation", () => {
  it("exposes its page heading", () => {
    render(createElement(Panel, { title: "Posts", children: "Post list" }));
    expect(screen.getByRole("heading", { name: "Posts", level: 1 })).toBeTruthy();
  });
  it("opens notification settings from the bell", () => {
    render(createElement(Panel, { title: "Posts", children: "Post list" }));
    fireEvent.click(screen.getByRole("button", { name: /Notification/ }));
    expect(navigation.navigate).toHaveBeenCalledWith({ to: "/dashboard/settings/notifications" });
  });
});

describe("editor focus", () => {
  it("focuses a newly opened board name, then keeps focus while editing its description", () => {
    render(createElement(BoardsRoute.options.component as ComponentType));
    fireEvent.click(screen.getByRole("button", { name: "New board" }));
    expect(document.activeElement).toBe(screen.getByPlaceholderText("Board name"));
    const description = screen.getByPlaceholderText("One-line description");
    description.focus();
    fireEvent.change(description, { target: { value: "Customer requests" } });
    expect(document.activeElement).toBe(description);
  });

  it("keeps focus on the color field while editing a new status", () => {
    const { container } = render(createElement(StatusesRoute.options.component as ComponentType));
    fireEvent.click(screen.getByRole("button", { name: "New status" }));
    const label = screen.getByPlaceholderText("Label");
    expect(document.activeElement).toBe(label);
    const color = container.querySelectorAll("input")[1];
    if (!color) throw new Error("Status color field missing");
    color.focus();
    fireEvent.change(color, { target: { value: "#123456" } });
    expect(document.activeElement).toBe(color);
  });
});

describe("mobile navigation", () => {
  it.each(["#product", GITHUB])("allows native navigation to %s and closes the drawer", (href) => {
    const { container } = render(createElement(Nav));
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    const link = container.querySelector(`ul a[href="${href}"]`);
    if (!link) throw new Error("Mobile link missing");
    let prevented: boolean | undefined;
    const observe = (event: MouseEvent) => {
      prevented = event.defaultPrevented;
      // Observe the application's decision without starting jsdom navigation.
      event.preventDefault();
    };
    window.addEventListener("click", observe, { once: true });
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    try {
      fireEvent.click(link);
      expect(prevented).toBe(false);
      expect(document.body.style.overflow).toBe("");
    } finally {
      window.removeEventListener("click", observe);
      scroll.mockRestore();
    }
  });
});
