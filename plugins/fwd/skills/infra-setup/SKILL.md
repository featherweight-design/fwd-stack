---
name: infra-setup
description: Use when creating a new app/project, or auditing an existing one, for hosting/database/monitoring defaults and running cost
---

# infra-setup

**First, read the project's own rules.** If `.claude/fwd/infra-setup.md` exists in the project, read
it before anything else: it names the project's own tools and conventions for this skill, and
its rules add to these and win where they conflict.

Defaults for the owner's apps (Vercel + Neon + Sentry + transactional email), in checklist form. Each item carries its reason. Most of them come from cost audits where the bulk of the hosting and database bill went on builds nobody needed and databases kept awake by a cron. The project's extension records its own audit figures and reference scripts.

Use it two ways:

- **New project:** work down the list before the first deploy.
- **Audit:** check each item against the live settings. Read the dashboards and APIs, not the repo alone, because a setting in a file is not a setting in effect.

**Owner-only actions are marked (owner).** An agent names them and stops.

## Secrets: the rule that governs everything below

- [ ] **The owner creates and sets every sensitive value by hand (owner).** That covers API keys, DSNs that are secret, webhook secrets, database URLs and auth tokens. An agent gives exactly three things per variable: its **name**, its **scope** (which project, and Production / Preview / Development) and whether it is **Sensitive**. An agent never routes a value through a file, a chat, a commit or `.env`. The owner's own local copy of a reusable production secret goes in the Keychain (see [Local secret store](#local-secret-store)).
      _Why:_ a value that passes through an agent's context or a file can leak through logs, transcripts or a commit, and the owner then has no record of where it went.
- [ ] **Scope is part of the value.** A variable that only production builds read goes in **Production scope alone**. A copy scoped to Preview is inert.
      _Why:_ a migration URL re-scoped to Preview can break production deploys for hours. The variable existed, but nothing read it from there.
- [ ] **Mark it Sensitive unless the browser needs it.** A `NEXT_PUBLIC_*` value is inlined into the bundle, and marking it Sensitive breaks that inlining.

## Local secret store

Vercel Sensitive variables cannot be read back, so an owner who needs a reusable production secret on their own machine (a migration URL, an admin token) needs a local copy. It lives in the macOS login Keychain. It does not live in a shell-profile export (`.zshrc` and similar), because every process inherits those, agent sessions included. It does not live in a `.env` file or a password manager either.

- [ ] **Store it without echo or shell history (owner).** `security add-generic-password -U -a "$USER" -s <app>-prod-<name> -T ""`. With no value given, it prompts twice. To generate the value instead, append `-w "$(openssl rand -hex 32)"`. To copy it out for the hosting dashboard: `security find-generic-password -s <app>-prod-<name> -w | pbcopy`.
- [ ] **Keep `-T ""`.** It trusts no app, so every read shows a macOS dialog the owner approves with **Allow**, never **Always Allow**. An agent cannot read a value silently.
- [ ] **Use it inline, one command at a time,** from a checkout with no `.env` setting that variable: `NAME="$(security find-generic-password -s <app>-prod-<name> -w)" pnpm <script>`. If the repo's script env loader uses dotenv `override: true`, a `.env` value beats the shell, so check the loader first.
- [ ] **An agent never runs the read command for the owner,** and never asks the owner to paste a value into chat. The kit's secret-guard hook already denies `security find-generic-password -w` and `-g`; leave it as it is.
      _Why:_ the dialog is the only gate between a stored secret and an agent session. Skipping it, or widening trust with Always Allow, removes the one check the owner controls.

## Where each variable lives

| Class                                                      | Where it is set                                                                               | Who sets it                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Public client keys (`NEXT_PUBLIC_*`)                       | Hosting provider environment, per environment scope, not Sensitive                            | Owner; an agent names the variable and scope |
| Server secrets (API keys, webhook secrets, `DATABASE_URL`) | Hosting provider environment, Production scope, Sensitive                                     | Owner, by hand                               |
| CI secrets (tokens a workflow reads)                       | GitHub Actions secrets or variables on the repo                                               | Owner, by hand                               |
| Migration-only URLs                                        | Hosting provider environment, Production scope alone; owner's local Keychain copy             | Owner, by hand                               |
| Local dev                                                  | Local env file with development values only; reusable production secrets stay in the Keychain | Each developer                               |

Production secrets never enter chat or the repo, and the owner rotates them by hand. Record each by name in `docs/secrets-inventory.md` (see [Secrets inventory](#secrets-inventory-names-only)).

## Standard third-party packages

A new project starts with these. They are not in `baseline.json` yet: the baseline check warns on any listed package whose major differs, so adding one holds every existing project to a major nobody has verified. Pin the major in the project, then add it to `baseline.json` once the first project settles on it.

| Need                | Package                                        |
| ------------------- | ---------------------------------------------- |
| Auth                | `@clerk/nextjs` (see [Auth](#auth-clerk))      |
| Product analytics   | `posthog-js`, `posthog-node` (see `analytics`) |
| Transactional email | `resend`                                       |
| Database driver     | `@neondatabase/serverless`                     |

## Neon (Postgres)

- [ ] **Set the compute range per environment, never leave the default.**
  - Production: start a small app at autoscaling min **0.5 CU**, max **2 CU**, then size from its measured load rather than leaving the provider default. _Why:_ a fixed floor above measured load is the main avoidable compute cost, and a ceiling of 2 CU absorbs a burst without a resize.
    - **Raise on evidence from the weekly check**, never on a feeling. In the console's monitoring view, read CPU, RAM and connection peaks over at least seven days, and read CU-hours in the weekly cost check. Raise the max when CPU sits near the ceiling for sustained stretches or connections hit the limit. Raise the min when users see slow first requests that are not cold starts, or when RAM use is near the floor and the cache hit rate drops. Lower either when the peak stays under half the setting for a month.
  - Staging: the default, min **0.25 CU**, max **1 CU**, scale to zero after **5 minutes**. Nobody reads it overnight. _Why:_ staging has no real traffic, a ceiling costs nothing until it is used but caps a runaway job, and the same setting on every product keeps spend easy to read.
  - Local dev: **0.25 CU**.
  - Scratch branches: **0.25 CU fixed** (`compute: {min_cu: 0.25, max_cu: 0.25}` on `create_branch`). Never the 1 CU default.

  _Why:_ a branch inherits 1 CU unless told otherwise. Forgotten scratch branches at 1 CU can run up a real bill in a month.

- [ ] **Every Neon step has a console or API path when the Neon MCP is not connected.** Console: Project, Branches, select the branch, Compute, Edit (set min and max CU, and the suspend timeout). API, with a token the owner creates and exports for the one command (owner): `PATCH /projects/{project_id}/endpoints/{endpoint_id}` with `autoscaling_limit_min_cu`, `autoscaling_limit_max_cu` and `suspend_timeout_seconds`; `POST /projects/{project_id}/branches` with an `endpoints` entry carrying the same limits and an `expires_at` for a scratch branch; `DELETE /projects/{project_id}/branches/{branch_id}` to remove one. Read the endpoint back to confirm. Check field names against Neon's API reference before use.
- [ ] **Scale-to-zero on** (the suspend timeout left at the 5-minute default, never disabled). _Why:_ a sleeping compute costs nothing. The first request after sleep costs about a second.
- [ ] **No cron at or under the 5-minute suspend window, against any database.** _Why:_ a 5-minute sweep keeps a database awake around the clock, which can be most of its compute bill. Moving the sweep to every 30 minutes lets it sleep.
- [ ] **Delete every scratch branch when its work merges, and set a TTL when creating one.** Before deleting, confirm by branch id that it is not production, staging or local-dev. _Why:_ branches beyond the included 10 are billed each month, and a forgotten one keeps its compute and storage.
- [ ] **Watch egress.** Neon counts data read OUT through the proxy, so probes and dev servers reading big pages add up (a local-dev branch can read tens of GB in a month). Check the plan's included egress. Point heavy probes at a small scratch branch. _Why:_ egress is free until the included amount, then billed per GB.
- [ ] **History retention at the minimum the project needs** (often 1 day). _Why:_ history is billed per GB-month.

## Vercel

- [ ] **Ignored Build Step** (`ignoreCommand` in `vercel.json`), as an ALLOWLIST of paths the build cannot read: `docs/`, `design/`, `.github/`, `.claude/` and root `*.md`. Exclude any of those the app reads at runtime. Whenever it is unsure, BUILD. Diff against `VERCEL_GIT_PREVIOUS_SHA` so skipped commits roll into the next build. The extension may name a reference implementation. _Why:_ a fair share of pushes typically touch nothing the app reads, and Build CPU is often the largest line on the bill. A wrongly skipped build ships stale code, so the rule must lean toward building.
- [ ] **Previews off when the project is created.** Right after creating it, turn preview deployments off with the API, then read the project back and check the field is `true`:

  ```bash
  pnpm dlx vercel api /v9/projects/<name> -X PATCH -F previewDeploymentsDisabled=true --scope <team>
  pnpm dlx vercel api /v9/projects/<name> --scope <team> | jq .previewDeploymentsDisabled
  ```

  Without the Vercel CLI, send the same PATCH and GET to `https://api.vercel.com/v9/projects/<name>?teamId=<team id>` with a token the owner exports for that one command, or use the project's settings page in the dashboard.

  Turn previews back on only if the project actually uses them. Leave git deployments off too unless the project deploys from git (`git.deploymentEnabled: false`, or `gitProviderOptions.createDeployments: "disabled"`). _Why:_ every branch push otherwise builds, and Build CPU is billed. Previews have had to be switched off by hand after the fact more than once.

- [ ] **One build per commit.** A second project that rebuilds the same commit (a staging twin) doubles Build CPU. Build staging from main only (ignore any other ref), and consider whether it needs every push at all. _Why:_ otherwise it is a steady monthly cost for an identical artifact.
- [ ] **Crons at 15 minutes or slower, enforced by a cadence guard in CI.** The guard is a test that parses `vercel.json` and fails on a schedule under the floor, with an allowlist that records a reason per path (the extension may name a reference implementation). Use off-the-hour minutes (`17 * * * *`). _Why:_ the cron's own invocation cost is pennies. The cost is the database it keeps awake (see Neon).
- [ ] **Set a deployment retention policy** on each project. Keep enough recent production deployments for Instant Rollback. _Why:_ a thousand deployments a month pile up, and retention is the setting that bounds them.

## Staging footprint

Staging exists to be checked before a release, not to run all day. Neon bills compute for every minute a database is awake, and a staging database that a cron wakes every few minutes never sleeps. In one case, an app's staging compute was about the same as its production compute, for an environment nobody used most of the day.

- [ ] **Staging databases and crons wake only on demand or once a day.** Never on a sub-hourly schedule. On demand means a person, a deploy or a test run asks for it.
      _Exception:_ an app that promotes to production only after a green staging end-to-end run (one app does) wakes staging for each promotion. That is on demand too.
- [ ] **Staging crons do nothing by default.** Each cron handler checks the environment and returns early on staging unless an explicit override is set. For example, one app uses `STAGING_CRONS='run'`. Set the override only while you are testing a cron, then unset it.
      _Why:_ a schedule in `vercel.json` applies to every project that deploys the file, staging included, so the default has to be off in the code.
- [ ] **Staging Vercel projects build on a fixed Standard build machine, with on-demand concurrent builds off.**
      _Why:_ a larger machine or extra concurrent builds buy speed nobody waits for on staging, and both are billed.
- [ ] **Preview deployments stay off** (see Vercel above).

## Secrets inventory (names only)

- [ ] **Each app keeps `docs/secrets-inventory.md`**, a list of every secret by NAME, never by value. Each row gives where the secret lives (Vercel project and environment, GitHub Actions secret or variable, local `.env.local`), what reads it, and who owns rotating it. Start from [`secrets-inventory-template.md`](secrets-inventory-template.md) in this skill's folder. Update it in the same PR that adds, moves or removes a secret.
      _Why:_ when a key leaks or expires, the first question is where else it is set and what breaks when it changes. A names-only list answers that without becoming a secret itself. A dedicated secrets manager was considered and dropped for now, since two apps do not need one; revisit when a third project arrives.

## Sentry (errors only)

- [ ] **Errors only:** no tracing, no replay, no logs. Pin `@sentry/nextjs` exactly. _Why:_ the other products are the billed volume, and nothing here reads them.
- [ ] **`instrumentation.ts`** with `register` (server and edge init) and `onRequestError = Sentry.captureRequestError`, plus `instrumentation-client.ts` for the browser. _Why:_ `onRequestError` covers render, route handlers, Server Actions and middleware in one place.
- [ ] **A route that answers 500 itself** (webhooks, crons) calls a capture helper with a fixed tag. _Why:_ a handled error never reaches `onRequestError`.
- [ ] **Scrub before send** (`beforeSend`), as a pure tested function. Remove the user, cookies, headers, request body, query string, `extra`, server name and exception MESSAGES. Keep type, stack and digest. Keep breadcrumbs for navigation and clicks only, query strings cut and tokens in paths replaced. _Why:_ messages and bodies carry user data and webhook signatures.
- [ ] **Dormant without a DSN:** the SDK enables only when a DSN is set AND the environment is named and not `local`. Dev machines and previews send nothing. _Why:_ no kill switch is needed; unsetting the DSN and redeploying turns it off.
- [ ] **The owner sets the variables (owner)**, Production scope on each project, Preview unset:
  - `SENTRY_DSN`: Sensitive.
  - `SENTRY_AUTH_TOKEN`: Sensitive, scopes `project:releases` and `org:read`.
  - `NEXT_PUBLIC_SENTRY_DSN`: not Sensitive, because it is inlined.
  - Environment, org and project names: not Sensitive.

  Source maps upload only when the token, org and project are all set, and are deleted from the output afterwards.

- [ ] **Add the ingest host to the CSP's `connect-src`.**

## Monitoring dashboards by API

Sentry dashboards, PostHog insights and dashboards, and Better Stack status pages and heartbeats are built from a spec by API, never clicked together in a console.

- [ ] **The app keeps its spec at `.claude/fwd/monitoring.json`**, in the schema in [`monitoring-spec.md`](monitoring-spec.md) ([`monitoring.example.json`](monitoring.example.json) is a fictional example). It holds names and ids, never a token. _Why:_ a dashboard made by hand cannot be reviewed, rebuilt or copied to the next app, and drifts without anyone noticing.
- [ ] **Apply it with `monitoring-apply.mjs`** from this skill's folder, run from the app's root:

  ```bash
  node <skill>/monitoring-apply.mjs                  # dry run: prints create / update / unchanged per object
  node <skill>/monitoring-apply.mjs --apply          # makes those writes
  node <skill>/monitoring-apply.mjs --only posthog   # one vendor
  ```

  It is idempotent (a second run reports everything unchanged), never deletes, and leaves alone anything the spec does not name. Read the dry run before `--apply`. Tokens go only to each vendor's own https API hosts; a self-hosted `host` needs `--allow-host <hostname>`. If a write fails, the run stops and lists what was done, where it failed and what did not run.

- [ ] **The owner creates the tokens (owner)** and keeps them in `~/.config/fwd/monitoring.env` (outside every repo; `--env-file` names another file). The tool reads only these variables, and prints none of them:
  - `FWD_SENTRY_TOKEN`: a Sentry auth token with `org:read` (the dashboard endpoints accept `org:read`, `org:write` or `org:admin`; use `org:write` if a write is refused).
  - `FWD_POSTHOG_KEY`: a PostHog personal API key scoped to the project, with `insight:read`, `insight:write`, `dashboard:read` and `dashboard:write`.
  - `FWD_BETTERSTACK_TOKEN`: a Better Stack team-scoped Incidents (Uptime) API token, or a global API token (then heartbeats need `team_name` in the spec).

  In a dry run a vendor without its token is skipped with a note. `--apply` refuses to start until every vendor it would touch has one. _Why:_ the tokens can edit live monitoring, so they stay with the owner and out of every file an agent writes.

## Auth (Clerk)

Flow design and error handling live in [`auth-flows`](../auth-flows/SKILL.md). This section is the account setup.

- [ ] **One Clerk instance per environment:** a development instance for local and preview, a production instance for the live domain. _Why:_ a shared instance mixes test users with real ones and ties local keys to production data.
- [ ] **Keys per instance (owner):** `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (public, not Sensitive) and `CLERK_SECRET_KEY` (Sensitive, Production scope on the production project). The production instance has its own keys; development keys never ship to production.
- [ ] **Bot protection on** for sign-up in the production instance. _Why:_ open sign-up gets scripted account creation within days of launch.
- [ ] **Allowed domains:** set the production instance's home URL and allowed origins to the live domain only. _Why:_ a stray origin lets another site host the sign-in.
- [ ] **Webhook secret (owner):** create the endpoint in the Clerk dashboard, point it at the app's webhook route, and set its signing secret as `CLERK_WEBHOOK_SIGNING_SECRET` (Sensitive). The route verifies the signature before it reads the body and fails closed when the secret is unset.

## Uptime (Better Stack)

- [ ] **Add one uptime monitor per production app on its health route** (`/api/health`). Interval **3 minutes** for a small app, a **30 second** confirmation period before it pages, and one alert channel the owner reads on a phone (push or SMS first, email second). Staging gets no monitor.
- [ ] **Keep the health route off the database.** It returns 200 from the app process alone. A second route (`/api/health/deep`) checks the database and is polled by hand or at 30 minutes or slower, never at the shallow interval. _Why:_ a poll under the 5-minute suspend window keeps a serverless database awake around the clock (see Neon).
- [ ] **No writer exists for this yet.** `monitoring-apply.mjs` manages heartbeats and status pages and looks up existing monitors by name; it does not create them. Create the monitor in the Better Stack console, or with its Uptime API and the owner's token (owner). Add it to the status page by name afterward through the spec.

## Email (transactional sending domain, Resend)

- [ ] **Verify the sending domain in Resend (owner):** add the domain in the dashboard, publish the DNS records it shows (SPF, DKIM and the return-path record), and wait for Verified. Send from a subdomain (`mail.acme-app.com`) so a reputation problem stays off the main domain.
- [ ] **Set the sender** as `Name <hello@mail.acme-app.com>`, in one place in code, read from a variable. _Why:_ a send from an unverified domain is rejected.
- [ ] **Webhook (owner):** add an endpoint for bounce and complaint events, set its signing secret as `RESEND_WEBHOOK_SECRET` (Sensitive), and verify the signature in the route. Suppress addresses that bounce or complain.
- [ ] **API key (owner):** `RESEND_API_KEY`, Sensitive, Production scope, sending access only.
- [ ] **Plan:** the free plan covers development and a small launch. Move to a paid plan before launch if the app needs more than one verified domain, a higher daily send limit or longer log retention. Check the current limits on Resend's pricing page first; they change.

Authentication of the domain:

- [ ] **SPF** on the sending domain naming the provider. _Why:_ unauthenticated mail lands in spam or is rejected.
- [ ] **DKIM** with the provider's keys. _Why:_ it is the signature receivers actually trust.
- [ ] **DMARC, staged:** start at `p=none` with an aggregate report address (`rua=`), read the reports until only your own senders pass, then move to `p=quarantine`. _Why:_ going straight to quarantine can bin legitimate mail from a sender you forgot. `p=none` forever leaves the domain open to spoofing.
- [ ] **The sending code fails closed** when its key is unset. _Why:_ a silent no-op looks like success.

## Running cost, in every plan

- [ ] **Every plan that adds a cron, a scheduled job, a model call or a piece of infrastructure carries a "Running cost" line:** what it costs per run or per month, at what cadence, and what it keeps awake. A model call states its model, prompt size and calls per reader or per run. _Why:_ big hosting costs are usually a small default nobody priced (a 5-minute cron, a 1 CU branch, a twin build).

## Claude Code on the machine

- [ ] **`"autoCompactWindow": 300000`** and **`"env": { "CLAUDE_CODE_SUBAGENT_MODEL": "sonnet" }`** in `~/.claude/settings.json` (owner). _Why:_ every turn re-reads the whole context, and without the window a session grows to near the model's full context before it compacts. Details in `run-project` §6.

## The weekly cost check

- [ ] **Read the bills weekly**, or run a scheduled read-only job that does. It compares this week with last week and goes red when a threshold is passed:
  - Vercel weekly list cost and Build CPU minutes, each against last week.
  - Neon CU-hours, egress, branch count over 10, and any `scratch-*` compute above 0.25 CU.

  The job calls GET endpoints only, uses tokens the owner creates (owner), and prints every figure whether or not it is red. _Why:_ a cost that starts quietly (a branch left at 1 CU, a cron sped up) shows up a week later instead of at the month's invoice.
