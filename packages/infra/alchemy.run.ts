import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { config } from "dotenv";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { z } from "zod";

// One checkout can run several independent instances. OPENHEARD_INSTANCE
// (unset = the upstream single-instance layout) picks a per-instance env
// file, ./.env.<instance>, loaded before ./.env so its values win, and names
// the stack. The stack name prefixes every physical resource name
// (alchemy/src/PhysicalName.ts: `${stack.name}-${id}-${stage}-`), and the
// state store indexes by stack (alchemy/src/Cloudflare/StateStore/Store.ts),
// so two instances never share a Worker, D1 database or KV namespace.
const blankIsUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const Instance = z.preprocess(blankIsUndefined, z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/).optional());
const Hostname = z.preprocess(
  blankIsUndefined,
  z
    .string()
    .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i)
    .optional(),
);
const ZoneId = z.preprocess(blankIsUndefined, z.string().regex(/^[0-9a-f]{32}$/).optional());

const instance = Instance.parse(process.env.OPENHEARD_INSTANCE);
if (instance) config({ path: `./.env.${instance}` });
config({ path: "./.env" });
config({ path: "../../apps/web/.env" });

const stackName = instance ? `openheard-${instance}` : "openheard";

// OPENHEARD_DOMAIN attaches a Cloudflare custom domain to the Worker
// (alchemy/src/Cloudflare/Workers/Worker.ts `domain?: string |
// WorkerDomainConfig`; Alchemy manages the DNS record and certificate, and the
// zone is inferred from the hostname's parent labels unless OPENHEARD_ZONE_ID
// pins it). Blank = no custom domain, workers.dev only. Set BETTER_AUTH_URL to
// https://<OPENHEARD_DOMAIN> alongside it so auth cookies and links use it.
const domainName = Hostname.parse(process.env.OPENHEARD_DOMAIN);
const zoneId = ZoneId.parse(process.env.OPENHEARD_ZONE_ID);
const domain: Cloudflare.WorkerDomainConfig | undefined = domainName ? { name: domainName, ...(zoneId ? { zoneId } : {}) } : undefined;

export const db = Cloudflare.D1.Database("database", {
  // flat .sql copies; drizzle-kit's own out dir (src/migrations) has meta/ which Alchemy rejects
  migrations: "../../packages/db/migrations",
});

export const cache = Cloudflare.KV.Namespace("CACHE");

export const email = Cloudflare.Email.SendEmail("EMAIL");

export const web = Cloudflare.Website.Vite("web", {
  rootDir: "../../apps/web",
  // With a custom domain the workers.dev URL is a second public origin that
  // Better Auth would refuse anyway (not in trustedOrigins); close it and the
  // version previews so the app has exactly one host.
  ...(domain ? { domain, workersDev: false } : {}),
  placement: { region: "aws:us-west-2" },
  compatibility: {
    flags: ["nodejs_compat"],
  },
  // Wipes the public demo workspace back to its seed, 04:00 UTC.
  crons: ["0 4 * * *"],
  env: {
    DB: db,
    CACHE: cache,
    EMAIL: email,
    BETTER_AUTH_SECRET: Config.redacted("BETTER_AUTH_SECRET"),
    BETTER_AUTH_URL: Config.string("BETTER_AUTH_URL").pipe(Config.withDefault("")),
    ROOT_DOMAIN: Config.string("ROOT_DOMAIN").pipe(Config.withDefault("")),
    // Sender for auth mail (password reset, magic link). Must be an address on a
    // domain the account has enabled for Cloudflare Email Sending
    // (`wrangler email sending list`); blank falls back to hello@openheard.com.
    AUTH_EMAIL_FROM: Config.string("AUTH_EMAIL_FROM").pipe(Config.withDefault("")),
    AUTH_EMAIL_FROM_NAME: Config.string("AUTH_EMAIL_FROM_NAME").pipe(Config.withDefault("")),
    GOOGLE_CLIENT_ID: Config.string("GOOGLE_CLIENT_ID").pipe(Config.withDefault("")),
    GOOGLE_CLIENT_SECRET: Config.string("GOOGLE_CLIENT_SECRET").pipe(Config.withDefault("")),
    STRIPE_SECRET_KEY: Config.string("STRIPE_SECRET_KEY").pipe(Config.withDefault("")),
    STRIPE_WEBHOOK_SECRET: Config.string("STRIPE_WEBHOOK_SECRET").pipe(Config.withDefault("")),
    STRIPE_PRICE_MONTHLY: Config.string("STRIPE_PRICE_MONTHLY").pipe(Config.withDefault("")),
    STRIPE_PRICE_YEARLY: Config.string("STRIPE_PRICE_YEARLY").pipe(Config.withDefault("")),
  },
  dev: {
    port: 3001,
  },
});

export type WebEnv = Cloudflare.InferEnv<typeof web>;

export default Alchemy.Stack(
  stackName,
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const webWorker = yield* web;

    return {
      web: webWorker.url,
    };
  }),
);
