# Self-hosting three openheard instances (feedback.aivaclaims.com, feedback.improvebayarea.com, feedback.improvecortland.com)

Runbook for the fork at `github.com/barkleesanders/openheard`. One checkout,
three independent Cloudflare stacks, each on its own custom domain, each
using the built-in `default` workspace. Nothing here is run by the code
changes themselves; `/ship` performs the marked steps, Barklee performs the
clicks.

Legend: **[ship]** = `/ship` runs it · **[hand]** = Barklee does it in a
browser · **[verify]** = a check with an expected result.

## Why three stacks, not one

Workspace resolution is host-based on `ROOT_DOMAIN` subdomains only
(`apps/web/src/lib/session.ts` `workspaceSlugFromHost`): anything that is not
`<slug>.<ROOT_DOMAIN>` resolves to `default`. A custom domain therefore always
lands on the `default` workspace, so each site gets its own Worker, D1 and KV.
`ROOT_DOMAIN` stays blank on all three.

How the fork makes that possible (`packages/infra/alchemy.run.ts`):

- `OPENHEARD_INSTANCE=<name>` loads `packages/infra/.env.<name>` before
  `./.env` and names the stack `openheard-<name>`. Alchemy prefixes every
  physical resource with the stack name and stage
  (`alchemy/src/PhysicalName.ts`: `${stack.name}-${id}-${stage}-<suffix>`;
  D1 via `Cloudflare/D1/Database.ts` `createDatabaseName`, KV via
  `Cloudflare/KV/Namespace.ts`, Worker via `Cloudflare/Workers/WorkerName.ts`)
  and keeps state per stack (`Cloudflare/StateStore/Store.ts`), so the three
  never touch each other's resources. Unset = upstream's single `openheard`
  stack.
- `OPENHEARD_DOMAIN=<host>` attaches the Worker custom domain
  (`Cloudflare/Workers/Worker.ts` `domain?: string | WorkerDomainConfig`):
  Alchemy creates the DNS record and edge certificate and makes
  `https://<host>` the Worker's primary URL. `OPENHEARD_ZONE_ID` pins the
  zone so no name lookup is needed.

Verified Cloudflare facts (read via the CF API 2026-09-20):

| Site | Zone id | `feedback.` DNS record today | Browser Integrity Check | Config rules (`http_config_settings`) |
|---|---|---|---|---|
| aivaclaims.com | `1e741eb60017d0c0a9d04e0e2ee100df` | none (the custom-domain binding creates it) | on | 2: `api-admin-disable-bic` (`/api/admin/`), `agent-surfaces-disable-bic` (`/mcp`, `llms.txt`, openapi, `.md`) |
| improvebayarea.com | `ce06a59364532aff60c4de445a4ba519` | none | on | 0 |
| improvecortland.com | `4410b5fe872be25e3ac716522696cf9a` | none | on | 0 |

Account id: `370916317cb5ba9f1162c8e420fa86b4`.

## 1. One-time: Alchemy login **[hand, then ship]**

```bash
cd packages/infra
bunx alchemy login --configure     # opens a browser; Barklee approves the Cloudflare grant
```

Writes `~/.alchemy/profiles.json`. Until that file exists every deploy fails at
auth (no other side effect). `bunx alchemy --help` / `bunx alchemy deploy --help`
list the real flags; the ones used below are `--stage`, `--dry-run`, `--yes`.

## 2. Per-instance env files **[ship]**

```bash
cd packages/infra
for i in aiva iba cortland; do cp "instances/$i.env-example" ".env.$i"; done
for i in aiva iba cortland; do
  sed -i '' "s/^BETTER_AUTH_SECRET=$/BETTER_AUTH_SECRET=$(openssl rand -base64 32 | tr -d '\n')/" ".env.$i"
done
git check-ignore -q .env.aiva .env.iba .env.cortland && echo ignored   # must print "ignored"
```

Templates live in `packages/infra/instances/` (named `*.env-example` so no
`.env.*` path is ever committed). Each file already carries `OPENHEARD_INSTANCE`, `OPENHEARD_DOMAIN`,
`OPENHEARD_ZONE_ID`, `BETTER_AUTH_URL=https://feedback.<zone>` and a blank
`ROOT_DOMAIN`. A different secret per instance; never commit one
(`.gitignore` ignores `.env.*` and keeps only `*.example`).

## 2b. Auth security gate **[ship, blocking]**

Better Auth 1.7.1 swallows sender failures (`runInBackgroundOrAwait` in
`better-auth/dist/context/create-context.mjs`), so the fork records the delivery
outcome per request and turns it into a 503 in `hooks.after`; magic-link tokens
are stored hashed; the Origin gate is explicit. `betterauth.security.json` at the
repo root is the executable contract (profile `password-magic-link`, 10 real-SDK
assertions, 7 named source mutations). Run before every deploy, as its own command:

```bash
bun run gate:auth-security                                  # the contract tests (any machine)
node "$HOME/tools/betterauth/betterauth" security --repo "$PWD" --json   # + mutation run; exit 0 only
```

Auth mail is sent from `AUTH_EMAIL_FROM` (per-instance env). Cloudflare Email
Sending must be enabled for that address's domain — verified 2026-09-20 with
`wrangler email sending list`: `notifications.aivaclaims.com`,
`notifications.improvebayarea.com`, `notifications.improvecortland.com` are
enabled; the apexes are not, and `hello@openheard.com` (upstream's default) would
fail on every instance. `bun run deploy:instance` runs the gate then
`alchemy deploy --stage prod`.

## 3. Deploy, one instance at a time **[ship]**

Stage is `prod`, matching upstream's `.github/workflows/deploy.yml`
(`bunx alchemy deploy --yes --stage prod`). The default stage is
`dev_${USER}`; do not deploy without `--stage prod` or the resources get a
different prefix.

```bash
cd packages/infra
OPENHEARD_INSTANCE=aiva     bunx alchemy deploy --stage prod --dry-run   # plan only, review it
OPENHEARD_INSTANCE=aiva     bunx alchemy deploy --stage prod
OPENHEARD_INSTANCE=iba      bunx alchemy deploy --stage prod
OPENHEARD_INSTANCE=cortland bunx alchemy deploy --stage prod
```

Each run provisions `openheard-<instance>-database-prod-*` (D1, migrations
applied from `packages/db/migrations`), `openheard-<instance>-CACHE-prod-*`
(KV), the Email binding and the Worker, attaches `feedback.<zone>` and prints
`web: https://feedback.<zone>`. Do not pass `--env-file`: it feeds Effect's
config provider, not `process.env`, and the stack name and domain are read
from `process.env` at import time.

**[verify]** after each deploy:

```bash
H=feedback.aivaclaims.com   # then improvebayarea.com, improvecortland.com
curl -sS -o /dev/null -w '%{http_code}\n' "https://$H/"                     # 200
curl -sS -o /dev/null -w '%{http_code}\n' "https://$H/api/mcp"              # 401 (no key yet)
dig +short "$H" @1.1.1.1 | head -1                                           # a Cloudflare address, created by the binding
```

## 4. First sign-up becomes admin **[hand]**

`packages/auth/src/index.ts:129-133`: with `ROOT_DOMAIN` blank, the first
account created on an instance gets `role: "admin"`; every later one is a
member. So the very first sign-up on each of the three hosts must be Barklee.
Order: open `https://feedback.<zone>/` → Sign up (email + password, or Google
if `GOOGLE_CLIENT_ID`/`SECRET` were set) → land on `/welcome`, which asks for
the board name and website (`apps/web/src/routes/welcome.tsx`).

## 5. Branding, per site **[hand]** — Dashboard → Settings

Openheard applies the accent to the public board as the link colour and focus
ring (`apps/web/src/routes/__root.tsx:11`: `--link`, `--ring`) and as the
voted-pill background with `#0d0d0f` text (`dashboard/settings/branding.tsx:59`).
Surfaces (`packages/ui/src/styles/globals.css`): light `#f7f5f0` / card
`#ffffff`; dark `#0d0d0f` / card `#121214`. Ratios below are WCAG relative
luminance, computed 2026-09-20; AA text needs ≥ 4.5.

| | AIVA | ImproveBayArea | ImproveCortland |
|---|---|---|---|
| Name (Settings → General) | AIVA Claims | ImproveBayArea | ImproveCortland |
| Tagline (Settings → General) | Tell us what would make AIVA more useful for veterans. | Make government work for you. Tell us what to fix next. | See something. Report it. Follow it. Tell us what to build next. |
| Theme (Settings → Public board) | light | light | light |
| Accent (Settings → Branding) | `#005ea2` | `#007749` | `#1F4E5F` |
| Accent source | `AIVA-Frontend/src/react-app/index.css:44,70` `--va-primary` / `--color-primary` | `tools/improvebayarea/src/brand.ts:30` `primary` | `projects/improvecortland/src/brand.ts:11` `primary` (`--c-primary`) |
| Accent as text on light bg / card | 6.17 / 6.72 pass | 5.16 / 5.62 pass | 8.33 / 9.08 pass |
| Accent as text on dark bg / card | 2.89 / 2.78 **fail** | 3.45 / 3.33 **fail** | 2.14 / 2.06 **fail** |
| `#0d0d0f` text on the voted pill | 2.89 | 3.45 | 2.14 |
| Website (asked on `/welcome`) | https://aivaclaims.com | https://improvebayarea.com | https://improvecortland.com |
| Logo (existing public asset, curl 200 on 2026-09-20) | https://aivaclaims.com/favicon.svg (also `/favicon-192.png`) | https://improvebayarea.com/icon-192.svg (also `/favicon.svg`) | https://improvecortland.com/favicon.svg (also `/og.jpg`) |

Notes:

- Theme is **light** on all three because each brand's primary is a dark
  colour that fails on openheard's dark surfaces. There is no single hex that
  passes both as text on the light surfaces (needs luminance ≤ 0.163) and
  under `#0d0d0f` pill text (needs ≥ 0.193), so the pill ratios above are
  what openheard's own pill design yields for any AA-passing link colour; the
  pill shows a vote count, not body text. Do not substitute the sites' gold
  accents (`#F0B442` 1.70, `#C9922E` 2.52 on light) — those are decorative.
- Tagline: the workspace default is "Vote on what matters. We read every post
  and reply on the ones we ship." (`packages/db/src/schema/feedback.ts:31`);
  the site taglines above come from `brand.ts` (`Make government work for
  you.`, `See something. Report it. Follow it.`) and AIVA's `index.html`
  description, each extended with one board-specific sentence.
- Logo: the `workspace.logo_url` column exists
  (`packages/db/src/schema/feedback.ts:37`) but this version has **no
  dashboard field that writes it** (`rg logoUrl apps/web/src` finds only
  `demo-db.ts`). Record the URL; set it later through the D1 console
  (`UPDATE workspace SET logo_url = '<url>' WHERE id = 'default'`) or leave
  unset. The public board never reads it: `components/header.tsx:39` renders
  the built-in `<Logo />` mark (`rg -i logo apps/web/src` shows no `logoUrl`
  reader), so today the value is inert either way.
- The AIVA font is Public Sans, but openheard ships Geist and has no font
  setting; the board keeps Geist.

## 6. API key **[hand]**

Dashboard → Settings → Developers → **API keys**
(`/dashboard/settings/api-keys`, `apps/web/src/lib/admin-nav.ts:5`). Create one
key per instance, named `muse-nova`. The plain `oh_…` value is shown once;
paste it straight into Muse (step 8). Keys are hashed at rest
(`apps/web/src/lib/api-auth.ts`).

**[verify]** the connectivity probe this fork adds (`docs/mcp.md`
"Connectivity probe"):

```bash
curl -sS "https://feedback.<zone>/api/mcp" -H "Authorization: Bearer oh_…"
# 200 {"name":"openheard","version":"0.1.0","transport":"streamable-http","tools":[…10 names…],"docs":"…"}
curl -sS -o /dev/null -w '%{http_code}\n' "https://feedback.<zone>/api/mcp" -H "Authorization: Bearer oh_bogus"
# 401
```

## 7. Cloudflare Browser Integrity Check exemption **[ship]**

Muse's VM fetches with a `Python-urllib` user agent, which BIC blocks with
403 before the Worker sees the request. Each feedback host needs a
Configuration Rule in phase `http_config_settings` with expression
`(http.host eq "feedback.<zone>")` (the whole host, because Muse needs both
`/api/mcp` and the board) and `action_parameters: { "bic": false }`. On
aivaclaims.com the rule is **added alongside** the two existing rules; on the
other two zones it is the first rule. Read the existing entrypoint first and
mirror its shape rather than composing from memory:

```bash
Z=1e741eb60017d0c0a9d04e0e2ee100df   # aivaclaims.com; ce06a593… for IBA, 4410b5fe… for Cortland
curl -sS "https://api.cloudflare.com/client/v4/zones/$Z/rulesets/phases/http_config_settings/entrypoint" \
  -H "X-Auth-Email: $CLOUDFLARE_EMAIL" -H "X-Auth-Key: $CLOUDFLARE_API_KEY" | jq '.result.rules[] | {description, expression, action, action_parameters}'
# then POST one rule to /zones/$Z/rulesets/<entrypoint id>/rules with
# {"description":"feedback-disable-bic","expression":"(http.host eq \"feedback.aivaclaims.com\")","action":"set_config","action_parameters":{"bic":false},"enabled":true}
```

**[verify]** positive control, before any key exists (401 = the Worker
answered; 403 = BIC still in the way):

```bash
curl -A 'Python-urllib/3.12' -o /dev/null -w '%{http_code}\n' https://feedback.<zone>/api/mcp
# expected 401
```

## 8. Muse custom connector **[hand]**

In muse.ai, for the agent "Nova": Vault → custom connector →
URL `https://feedback.<zone>/api/mcp`, key = the `oh_` value from step 6. The
Connect button performs a live `GET` with `Authorization: Bearer <key>` and no
`Accept: text/event-stream`, and stores the key only on a 2xx (measured
2026-09-17). Before this fork that GET returned 406 from the MCP SDK
transport; `apps/web/src/routes/api/mcp.ts` now answers 200 JSON
(`apps/web/src/lib/mcp-route.test.ts`). Repeat for all three instances.

### 8b. Nova daily triage job **[hand or muse-ask]**

Once all three connectors show connected, send Nova the prompt in
[`muse-nova-triage-job.md`](muse-nova-triage-job.md) — either paste it into the
Nova chat or run `muse-ask "$(cat docs/muse-nova-triage-job.md)"` from a
machine where `muse-bridge` is up. Then confirm it landed: the prompt's job id
`openheard-feedback-triage` must appear in the chat DOM (the bridge's
"submitted" ack alone is not proof). The job is read-mostly: it may
`draft_changelog`, and never calls `set_status`, `add_comment` or
`publish_changelog` without an explicit go in chat.

## 9. Update runbook after shipping **[ship]**

Record the three Worker URLs, D1 ids and the config-rule ids in this file's
Verified-facts table, with the date.
