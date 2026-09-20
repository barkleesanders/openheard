import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Better Auth security contract (betterauth.security.json at the repo root).
// Plain node, in-memory libsql, no Worker runtime; the env module is mocked
// inside the test so `cloudflare:workers` is never imported.
export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: { BETTER_AUTH_SECRET: "test-secret-not-a-real-one-32chars" },
  },
});
