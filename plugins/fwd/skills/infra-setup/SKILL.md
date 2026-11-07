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

- [ ] **The owner creates and sets every sensitive value by hand (owner).** That covers API keys, DSNs that are secret, webhook secrets, database URLs and auth tokens. An agent gives exactly three things per variable: its **name**, its **scope** (which project, and Production / Preview / Development) and whether it is **Sensitive**. An agent never routes a value through a file, a chat, a commit or `.env`.
      _Why:_ a value that passes through an agent's context or a file can leak through logs, transcripts or a commit, and the owner then has no record of where it went.
- [ ] **Scope is part of the value.** A variable that only production builds read goes in **Production scope alone**. A copy scoped to Preview is inert.
      _Why:_ a migration URL re-scoped to Preview can break production deploys for hours. The variable existed, but nothing read it from there.
- [ ] **Mark it Sensitive unless the browser needs it.** A `NEXT_PUBLIC_*` value is inlined into the bundle, and marking it Sensitive breaks that inlining.

## Neon (Postgres)

- [ ] **Set the compute range per environment, never leave the default.**
  - Production: fixed **1 CU**. Its page cache keeps reads fast for real users. A small app's CPU typically peaks far below 1 CU, so more than 1 CU buys nothing; check the project's own peak before raising it.
  - Staging: autoscale **0.25 to 1 CU**. Nobody reads it overnight.
  - Local dev: **0.25 CU**.
  - Scratch branches: **0.25 CU fixed** (`compute: {min_cu: 0.25, max_cu: 0.25}` on `create_branch`). Never the 1 CU default.

  _Why:_ a branch inherits 1 CU unless told otherwise. Forgotten scratch branches at 1 CU can run up a real bill in a month.

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

  Turn previews back on only if the project actually uses them. Leave git deployments off too unless the project deploys from git (`git.deploymentEnabled: false`, or `gitProviderOptions.createDeployments: "disabled"`). _Why:_ every branch push otherwise builds, and Build CPU is billed. Previews have had to be switched off by hand after the fact more than once.

- [ ] **One build per commit.** A second project that rebuilds the same commit (a staging twin) doubles Build CPU. Build staging from main only (ignore any other ref), and consider whether it needs every push at all. _Why:_ otherwise it is a steady monthly cost for an identical artifact.
- [ ] **Crons at 15 minutes or slower, enforced by a cadence guard in CI.** The guard is a test that parses `vercel.json` and fails on a schedule under the floor, with an allowlist that records a reason per path (the extension may name a reference implementation). Use off-the-hour minutes (`17 * * * *`). _Why:_ the cron's own invocation cost is pennies. The cost is the database it keeps awake (see Neon).
- [ ] **Set a deployment retention policy** on each project. Keep enough recent production deployments for Instant Rollback. _Why:_ a thousand deployments a month pile up, and retention is the setting that bounds them.

## Staging footprint

Staging exists to be checked before a release, not to run all day. Neon bills compute for every minute a database is awake, and a staging database that a cron wakes every few minutes never sleeps. In October, The 99's staging compute was about the same as its production compute, for an environment nobody used most of the day.

- [ ] **Staging databases and crons wake only on demand or once a day.** Never on a sub-hourly schedule. On demand means a person, a deploy or a test run asks for it.
      _Exception:_ an app that promotes to production only after a green staging end-to-end run (Concert Crawl does) wakes staging for each promotion. That is on demand too.
- [ ] **Staging crons do nothing by default.** Each cron handler checks the environment and returns early on staging unless an explicit override is set. The 99 uses `STAGING_CRONS='run'`. Set the override only while you are testing a cron, then unset it.
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

## Email (transactional sending domain)

- [ ] **SPF** on the sending domain naming the provider. _Why:_ unauthenticated mail lands in spam or is rejected.
- [ ] **DKIM** with the provider's keys. _Why:_ it is the signature receivers actually trust.
- [ ] **DMARC, staged:** start at `p=none` with an aggregate report address (`rua=`), read the reports until only your own senders pass, then move to `p=quarantine`. _Why:_ going straight to quarantine can bin legitimate mail from a sender you forgot. `p=none` forever leaves the domain open to spoofing.
- [ ] **The sending code fails closed** when its key is unset. _Why:_ a silent no-op looks like success.

## Running cost, in every plan

- [ ] **Every plan that adds a cron, a scheduled job, a model call or a piece of infrastructure carries a "Running cost" line:** what it costs per run or per month, at what cadence, and what it keeps awake. A model call states its model, prompt size and calls per reader or per run. _Why:_ big hosting costs are usually a small default nobody priced (a 5-minute cron, a 1 CU branch, a twin build).

## The weekly cost check

- [ ] **Read the bills weekly**, or run a scheduled read-only job that does. It compares this week with last week and goes red when a threshold is passed:
  - Vercel weekly list cost and Build CPU minutes, each against last week.
  - Neon CU-hours, egress, branch count over 10, and any `scratch-*` compute above 0.25 CU.

  The job calls GET endpoints only, uses tokens the owner creates (owner), and prints every figure whether or not it is red. _Why:_ a cost that starts quietly (a branch left at 1 CU, a cron sped up) shows up a week later instead of at the month's invoice.
