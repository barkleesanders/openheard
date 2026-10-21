import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const alchemy = createRequire(
  `${realpathSync(new URL('../packages/infra/node_modules/alchemy', import.meta.url))}/package.json`,
);
const glob = alchemy.resolve('fast-glob');
const micromatch = createRequire(glob).resolve('micromatch');
const consumers = [
  ['workspace', require('braces')],
  ['Alchemy fast-glob', createRequire(micromatch)('braces')],
];

// GHSA-vfj7-8cjw-p6xm has no published fix. Exercise the installed Bun patch
// through the real consumers, so an unapplied patch fails the release build.
for (const [name, braces] of consumers) {
  test(`${name}: rejects excessive nesting before recursive walkers`, () => {
    const nested = '{'.repeat(4500) + 'x' + '}'.repeat(4500);
    for (const operation of [braces.compile, braces.expand]) {
      assert.throws(() => operation(nested), {
        name: 'SyntaxError',
        message: 'Brace nesting exceeds maximum depth (100)',
      });
    }
  });

  test(`${name}: preserves normal patterns and the depth boundary`, () => {
    assert.deepEqual(braces.expand('src/{one,two}/*.ts'), ['src/one/*.ts', 'src/two/*.ts']);
    assert.equal(typeof braces.compile('{'.repeat(100) + 'x' + '}'.repeat(100)), 'string');
    assert.throws(() => braces.compile('{'.repeat(101) + 'x' + '}'.repeat(101)), SyntaxError);
  });
}
