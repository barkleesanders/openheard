import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start/server", () => ({
  createStartHandler: () => async () =>
    new Response("<html>Fixture page</html>", { headers: { "Content-Type": "text/html" } }),
  defaultStreamHandler: {},
}));

import worker from "../server";
import { isPrivatePath, isPublicCacheable } from "./cache";

describe("subscription token page privacy", () => {
  it.each(["/updates", "/updates/"])(
    "excludes %s from the public cache and sets response privacy headers",
    async (path) => {
      expect(isPrivatePath(path)).toBe(true);
      expect(isPublicCacheable(path)).toBe(false);
      const response = await worker.fetch(new Request(`https://fixture.test${path}?token=fixture-only`), {}, {
        waitUntil: vi.fn(),
      } as unknown as ExecutionContext);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    },
  );
  it("keeps the ordinary public-page referrer policy", async () => {
    const response = await worker.fetch(new Request("https://fixture.test/roadmap"), {}, {
      waitUntil: vi.fn(),
    } as unknown as ExecutionContext);
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });
});
