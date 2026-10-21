import { realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const mediaTypes = {
  ".txt": ["text/plain"],
  ".svg": ["image/svg+xml"],
  ".ico": ["image/x-icon", "image/vnd.microsoft.icon"],
  ".png": ["image/png"],
  ".webp": ["image/webp"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".gif": ["image/gif"],
  ".avif": ["image/avif"],
};

async function inventory(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(resolve(directory, prefix), { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (["_headers", "_redirects"].includes(name)) continue;
    if (entry.isDirectory()) files.push(...(await inventory(directory, `${name}/`)));
    else if (entry.isFile()) files.push(name);
    else throw new Error(`Unsupported public asset: ${name}`);
  }
  return files.sort();
}

export async function verifyPublicAssets({ sourceDir, buildDir, origin, fetcher = fetch }) {
  let files;
  try {
    files = await inventory(sourceDir);
    if (!files.length) throw new Error("Public asset inventory is empty");
  } catch (error) {
    return { status: "unmeasured", reason: error.message, checks: [] };
  }
  const checks = [];
  for (const name of files) {
    try {
      const expected = await readFile(resolve(sourceDir, name));
      if (origin) {
        const allowedTypes = mediaTypes[extname(name).toLowerCase()];
        if (!allowedTypes) {
          checks.push({ name, status: "unmeasured", reason: "Unknown media type" });
          continue;
        }
        const response = await fetcher(new URL(name, `${origin}/`), {
          redirect: "manual",
          signal: AbortSignal.timeout(15000),
        });
        const actual = Buffer.from(await response.arrayBuffer());
        const contentType = response.headers.get("Content-Type") ?? "";
        const correctType = allowedTypes.includes(contentType.split(";")[0].trim().toLowerCase());
        // Managed robots prepends policy text. The application's directives
        // still have to be present, rather than accepting its synthetic 200.
        const equal =
          name === "robots.txt"
            ? actual.toString().trimEnd().endsWith(expected.toString().trimEnd())
            : actual.equals(expected);
        checks.push({
          name,
          status: response.status === 200 && correctType && equal ? "ok" : "bad",
          httpStatus: response.status,
          correctType,
          equal,
        });
      } else {
        try {
          const actual = await readFile(resolve(buildDir, name));
          checks.push({ name, status: actual.equals(expected) ? "ok" : "bad" });
        } catch (error) {
          checks.push({ name, status: error.code === "ENOENT" ? "bad" : "unmeasured", reason: error.code });
        }
      }
    } catch (error) {
      checks.push({ name, status: "unmeasured", reason: error.name });
    }
  }
  const status = checks.some((check) => check.status === "bad")
    ? "bad"
    : checks.some((check) => check.status === "unmeasured")
      ? "unmeasured"
      : "ok";
  return { status, checks };
}

export function liveOrigin(value) {
  if (!value) throw new Error("A configured public origin is required");
  const url = new URL(value);
  if (url.username || url.password) throw new Error("Origin must not include credentials");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
    throw new Error("HTTPS origin required");
  return url.origin;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const live = process.argv.indexOf("--live");
  let origin;
  try {
    if (process.argv.includes("--live-config")) {
      const { config } = await import("dotenv");
      const instance = process.env.OPENHEARD_INSTANCE;
      if (instance && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(instance)) throw new Error("Invalid instance name");
      if (instance) config({ path: resolve(root, `packages/infra/.env.${instance}`), quiet: true });
      config({ path: resolve(root, "packages/infra/.env"), quiet: true });
      config({ path: resolve(root, "apps/web/.env"), quiet: true });
      origin = liveOrigin(process.env.BETTER_AUTH_URL);
    } else if (live !== -1) origin = liveOrigin(process.argv[live + 1]);
  } catch (error) {
    console.log(JSON.stringify({ status: "unmeasured", scope: "configuration", reason: error.message }));
    process.exit(2);
  }
  if (process.argv.includes("--check-origin")) {
    if (!origin) throw new Error("Origin check requires a live origin");
    console.log(JSON.stringify({ status: "ok", scope: "configuration", origin }));
    process.exit(0);
  }
  const result = await verifyPublicAssets({
    sourceDir: resolve(root, "apps/web/public"),
    buildDir: resolve(root, "apps/web/dist/client"),
    origin,
  });
  console.log(JSON.stringify(result));
  process.exitCode = result.status === "ok" ? 0 : result.status === "bad" ? 1 : 2;
}
