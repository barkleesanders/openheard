import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { defineConfig } from "vite";
import { clientServerLeaks } from "../../scripts/release-boundaries.mjs";

const local = process.env.OPENHEARD_LOCAL === "1";

export default defineConfig({
  server: {
    port: 3001,
  },
  build: {
    modulePreload: { polyfill: false },
    rollupOptions: {
      // resolved by workerd at runtime; node builds cannot bundle it
      external: local ? [] : ["cloudflare:workers"],
    },
    rolldownOptions: {
      external: local ? [] : ["cloudflare:workers"],
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react-vendor",
              test: /[\\/]node_modules[\\/](react|react-dom)[\\/]/,
            },
          ],
        },
      },
    },
  },
  resolve: {
    tsconfigPaths: true,
    alias: local
      ? { "cloudflare:workers": fileURLToPath(new URL("../../packages/env/src/local.ts", import.meta.url)) }
      : {},
  },
  ssr: {
    // native sqlite driver stays external in local mode
    external: ["@libsql/client", "libsql"],
  },
  environments: {
    ssr: {
      build: {
        // One server file. Split chunks can import each other in a cycle on workerd
        // and evaluate a drizzle table before its base class exists.
        rolldownOptions: { output: { inlineDynamicImports: true, codeSplitting: false } },
      },
    },
  },
  plugins: [
    tailwindcss(),
    tanstackStart(),
    viteReact({ compiler: true }),
    {
      name: "openheard-release-boundaries",
      generateBundle(_options, bundle) {
        if (this.environment.name !== "client") return;
        const leaked = clientServerLeaks(bundle);
        if (leaked.length) this.error(`Server-only modules reached the browser: ${leaked.join(", ")}`);
      },
      closeBundle() {
        if (this.environment.name !== "client") return;
        execFileSync(process.execPath, [fileURLToPath(new URL("../../scripts/public-assets.mjs", import.meta.url))], {
          stdio: "inherit",
        });
      },
    },
  ],
});
