import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

test("Alchemy platform packages load with its pinned Effect runtime", () => {
  execFileSync(
    "bun",
    ["-e", 'await import("@effect/platform-bun/BunServices"); await import("@effect/platform-node/NodeServices");'],
    {
      cwd: new URL("../packages/infra", import.meta.url),
      stdio: "pipe",
      timeout: 20000,
    },
  );
});

const consumers = [
  ["Alchemy", "../packages/infra/node_modules/alchemy"],
  ["shadcn", "../packages/ui/node_modules/shadcn"],
].map(([name, packagePath]) => {
  const consumer = createRequire(`${realpathSync(new URL(packagePath, import.meta.url))}/package.json`);
  const glob = consumer.resolve("fast-glob");
  const micromatch = createRequire(glob).resolve("micromatch");
  const requireBraces = createRequire(micromatch);
  return [name, requireBraces("braces"), requireBraces];
});

// GHSA-vfj7-8cjw-p6xm has no published fix. Exercise the installed Bun patch
// through the real consumers, so an unapplied patch fails the release build.
for (const [name, braces, requireBraces] of consumers) {
  test(`${name}: rejects excessive nesting before recursive walkers`, () => {
    const nested = `${"{".repeat(4500)}x${"}".repeat(4500)}`;
    for (const operation of [braces.compile, braces.expand]) {
      assert.throws(() => operation(nested), {
        name: "SyntaxError",
        message: "Brace nesting exceeds maximum depth (100)",
      });
    }
  });

  test(`${name}: preserves normal patterns and the depth boundary`, () => {
    assert.deepEqual(braces.expand("src/{one,two}/*.ts"), ["src/one/*.ts", "src/two/*.ts"]);
    assert.equal(typeof braces.compile(`${"{".repeat(100)}x${"}".repeat(100)}`), "string");
    assert.throws(() => braces.compile(`${"{".repeat(101)}x${"}".repeat(101)}`), SyntaxError);
  });

  test(`${name}: bounds parentheses and mixed containers`, () => {
    for (const pattern of [`${"(".repeat(101)}x${")".repeat(101)}`, `${"{(".repeat(51)}x${")}".repeat(51)}`]) {
      for (const operation of [braces.parse, braces.compile, braces.expand, braces.stringify]) {
        assert.throws(() => operation(pattern), {
          name: "SyntaxError",
          message: "Brace nesting exceeds maximum depth (100)",
        });
      }
    }
    assert.equal(braces.stringify(`${"(".repeat(100)}x${")".repeat(100)}`), `${"(".repeat(100)}x${")".repeat(100)}`);
  });

  test(`${name}: protects public and direct walkers from deep or cyclic ASTs`, () => {
    const ast = (depth) => {
      let node = { type: "text", value: "x" };
      for (let i = 0; i < depth; i++) node = { type: "paren", nodes: [node] };
      return { type: "root", nodes: [node] };
    };
    const cyclic = { type: "root", nodes: [] };
    cyclic.nodes.push(cyclic);
    for (const operation of [
      braces.compile,
      braces.expand,
      braces.stringify,
      requireBraces("braces/lib/compile"),
      requireBraces("braces/lib/expand"),
      requireBraces("braces/lib/stringify"),
    ]) {
      for (const value of [ast(101), cyclic]) {
        assert.throws(() => operation(value), {
          name: "SyntaxError",
          message: "Brace nesting exceeds maximum depth (100)",
        });
      }
      assert.doesNotThrow(() => operation(ast(100)));
    }
  });
}
