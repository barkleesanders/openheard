import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { liveOrigin, verifyPublicAssets } from "./public-assets.mjs";

test("release origin requires explicit HTTPS configuration", () => {
  for (const value of [
    undefined,
    "",
    "not a URL",
    "http://feedback.example.test",
    "ftp://localhost",
    "https://user:secret@example.test",
  ])
    assert.throws(() => liveOrigin(value));
  assert.equal(liveOrigin("https://feedback.example.test/"), "https://feedback.example.test");
  assert.equal(liveOrigin("http://127.0.0.1:3001"), "http://127.0.0.1:3001");
});

test("missing root public files fail even when a nested asset is present", async () => {
  const root = await mkdtemp(join(tmpdir(), "openheard-assets-"));
  try {
    const sourceDir = join(root, "public"),
      buildDir = join(root, "build");
    await mkdir(join(sourceDir, "landing"), { recursive: true });
    await mkdir(join(buildDir, "landing"), { recursive: true });
    await writeFile(join(sourceDir, "favicon.svg"), "<svg/>");
    await writeFile(join(sourceDir, "landing/example.svg"), "<svg/>");
    await writeFile(join(buildDir, "landing/example.svg"), "<svg/>");
    const bad = await verifyPublicAssets({ sourceDir, buildDir });
    assert.equal(bad.status, "bad");
    assert.deepEqual(
      bad.checks.filter((x) => x.status !== "ok").map((x) => x.name),
      ["favicon.svg"],
    );
    await writeFile(join(buildDir, "favicon.svg"), "<svg/>");
    assert.equal((await verifyPublicAssets({ sourceDir, buildDir })).status, "ok");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed robots 200 and HTML masquerading as an icon fail content checks", async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), "openheard-public-"));
  try {
    await writeFile(join(sourceDir, "favicon.svg"), "<svg/>");
    await writeFile(join(sourceDir, "robots.txt"), "User-agent: *\nDisallow: /dashboard\n");
    const bad = await verifyPublicAssets({
      sourceDir,
      origin: "https://feedback.example.test",
      fetcher: async () => new Response("<html>Not found</html>", { headers: { "Content-Type": "text/html" } }),
    });
    assert.equal(bad.status, "bad");
    assert.equal(bad.checks.filter((x) => x.status === "bad").length, 2);
    const good = await verifyPublicAssets({
      sourceDir,
      origin: "https://feedback.example.test",
      fetcher: async (url) =>
        url.pathname === "/robots.txt"
          ? new Response("# Managed policy\nUser-agent: *\nDisallow: /dashboard\n", {
              headers: { "Content-Type": "text/plain" },
            })
          : new Response("<svg/>", { headers: { "Content-Type": "image/svg+xml" } }),
    });
    assert.equal(good.status, "ok");
    const wrongImageType = await verifyPublicAssets({
      sourceDir,
      origin: "https://feedback.example.test",
      fetcher: async () => new Response("<svg/>", { headers: { "Content-Type": "image/png" } }),
    });
    assert.equal(wrongImageType.checks.find((x) => x.name === "favicon.svg").status, "bad");
    const missing = await verifyPublicAssets({
      sourceDir,
      origin: "https://feedback.example.test",
      fetcher: async () => new Response("# Managed policy\n", { headers: { "Content-Type": "text/plain" } }),
    });
    assert.equal(missing.checks.find((x) => x.name === "robots.txt").status, "bad");
    const unavailable = await verifyPublicAssets({
      sourceDir,
      origin: "https://feedback.example.test",
      fetcher: async () => {
        throw new Error("network unavailable");
      },
    });
    assert.equal(unavailable.status, "unmeasured");
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
  }
});
