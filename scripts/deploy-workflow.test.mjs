import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const fromAlchemy = createRequire(
  join(realpathSync(join(root, "packages/infra/node_modules/alchemy")), "package.json"),
);
const workflow = fromAlchemy("yaml").parse(readFileSync(join(root, ".github/workflows/deploy.yml"), "utf8"));
const productionStep = workflow.jobs.deploy.steps.find((step) => step.env?.CLOUDFLARE_API_TOKEN);
const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function runWithRejectedQuality(step) {
  const directory = mkdtempSync(join(tmpdir(), "openheard-deploy-gate-"));
  try {
    const bin = join(directory, "bin");
    mkdirSync(bin);
    mkdirSync(join(directory, "packages/infra"), { recursive: true });
    const quality = join(directory, "quality-entered");
    const deployment = join(directory, "deployment-attempted");
    writeFileSync(
      join(directory, "reject-quality.mjs"),
      'import fs from "node:fs"; fs.writeFileSync("quality-entered", "fixture"); process.exit(47);\n',
    );
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ scripts: { ...scripts, "gate:quality": `${quote(process.execPath)} reject-quality.mjs` } }),
    );
    // Every Alchemy invocation is intercepted, including a broken workflow that
    // bypasses quality. This fixture has no platform credentials or app files.
    writeFileSync(join(bin, "bunx"), `#!/bin/sh\nprintf attempted > ${quote(deployment)}\nexit 99\n`, { mode: 0o700 });
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^(CLOUDFLARE_|CF_|GOOGLE_|STRIPE_|BETTER_AUTH_)/.test(name)),
    );
    const result = spawnSync("/bin/sh", ["-c", step.run], {
      cwd: join(directory, step["working-directory"] ?? "."),
      env: { ...env, PATH: `${bin}:${process.env.PATH}`, CI: "true" },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.error, undefined);
    return { qualityEntered: existsSync(quality), deploymentAttempted: existsSync(deployment), status: result.status };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("automatic main deployment reaches the actual release gate before Alchemy", () => {
  assert.deepEqual(workflow.on, { push: { branches: ["main"] } });
  assert(productionStep, "Production deployment step must exist");
  const result = runWithRejectedQuality(productionStep);
  assert.equal(result.qualityEntered, true, "The actual package release entrypoint must run quality");
  assert.notEqual(result.status, 0);
  assert.equal(result.deploymentAttempted, false, "Rejected quality must stop before Alchemy");
});

test("the direct-Alchemy negative control exposes the gate bypass without deploying", () => {
  const result = runWithRejectedQuality({
    run: "bunx alchemy deploy --yes --stage prod",
    "working-directory": "packages/infra",
  });
  assert.equal(result.qualityEntered, false);
  assert.equal(result.deploymentAttempted, true);
  assert.equal(result.status, 99);
});
