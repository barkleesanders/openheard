import assert from "node:assert/strict";
import { test } from "node:test";
import { clientServerLeaks } from "./release-boundaries.mjs";

test("retained browser-external shims block release; removed modules do not", () => {
  const bundle = {
    "index.js": {
      type: "chunk",
      modules: { "__vite-browser-external": { renderedLength: 32 }, "react.js": { renderedLength: 100 } },
    },
    "logo.svg": { type: "asset" },
  };
  assert.deepEqual(clientServerLeaks(bundle), ["__vite-browser-external"]);
  bundle["index.js"].modules["__vite-browser-external"].renderedLength = 0;
  assert.deepEqual(clientServerLeaks(bundle), []);
});
