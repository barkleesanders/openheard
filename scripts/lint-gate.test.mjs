import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const biome = fileURLToPath(new URL("../node_modules/@biomejs/biome/bin/biome", import.meta.url));

function check(directory, file) {
  return spawnSync(process.execPath, [biome, "check", "--error-on-warnings", "--config-path", directory, file], {
    encoding: "utf8",
    timeout: 10000,
  });
}

test("the release linter rejects a debugger statement and accepts clean source", () => {
  const directory = mkdtempSync(join(tmpdir(), "openheard-lint-"));
  try {
    const config = JSON.parse(readFileSync(join(root, "biome.json"), "utf8"));
    // Keep the real rule configuration; these isolated fixtures have no Git repository.
    config.vcs.enabled = false;
    writeFileSync(join(directory, "biome.json"), JSON.stringify(config));
    const source = join(directory, "apps/web/src");
    mkdirSync(source, { recursive: true });
    const file = join(source, "release-control.ts");
    writeFileSync(file, "export const marker = 1;\n");
    const good = check(directory, file);
    assert.equal(good.status, 0, `${good.error ?? ""}${good.stderr}`);
    writeFileSync(file, "debugger;\n");
    const bad = check(directory, file);
    assert.equal(bad.error, undefined);
    assert.equal(bad.status, 1, "Recommended lint rules must reject the known-bad control");
    assert.match(bad.stderr, /lint\/suspicious\/noDebugger/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
