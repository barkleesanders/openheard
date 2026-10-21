import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// Use the same generator version as the Start plugin, before tsc reads its output.
const root = fileURLToPath(new URL("../apps/web/", import.meta.url));
const requireWeb = createRequire(new URL("../apps/web/package.json", import.meta.url));
const { Generator, getConfig } = await import(pathToFileURL(requireWeb.resolve("@tanstack/router-generator")));
await new Generator({ config: getConfig({}, root), root }).run();
