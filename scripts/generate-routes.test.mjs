import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("route generation bootstraps a clean checkout before type checking", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const fixture = mkdtempSync(join(root, ".route-generation-test-"));
  try {
    mkdirSync(join(fixture, "scripts"));
    mkdirSync(join(fixture, "apps/web/src/routes"), { recursive: true });
    copyFileSync(new URL("generate-routes.mjs", import.meta.url), join(fixture, "scripts/generate-routes.mjs"));
    copyFileSync(join(root, "apps/web/package.json"), join(fixture, "apps/web/package.json"));
    symlinkSync(join(root, "apps/web/node_modules"), join(fixture, "apps/web/node_modules"), "dir");
    writeFileSync(
      join(fixture, "apps/web/src/routes/__root.tsx"),
      'import { createRootRoute } from "@tanstack/react-router"; export const Route = createRootRoute();\n',
    );
    writeFileSync(
      join(fixture, "apps/web/src/routes/health.tsx"),
      'import { createFileRoute } from "@tanstack/react-router"; export const Route = createFileRoute("/health")({});\n',
    );
    const output = join(fixture, "apps/web/src/routeTree.gen.ts");
    assert.equal(existsSync(output), false);
    const result = spawnSync(process.execPath, [join(fixture, "scripts/generate-routes.mjs")], {
      cwd: fixture,
      encoding: "utf8",
      timeout: 20000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(readFileSync(output, "utf8"), /health/);
    const web = JSON.parse(readFileSync(join(root, "apps/web/package.json"), "utf8"));
    assert.equal(web.scripts["check-types"], "bun run ../../scripts/generate-routes.mjs && tsc --noEmit");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
