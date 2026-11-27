---
name: analytics
description: Use when a new project needs product analytics, when adding or changing a tracked event, a cap, a dashboard or the analytics vendor config, and when reviewing a PR that touches one. The standard pattern for a Next.js project on PostHog's free tier: a closed typed event registry, per-session caps, privacy defaults, and dashboards as code applied by a dry-run-first workflow.
---

# analytics

One analytics pattern for every project. The aim is to see where people get to and what they do,
with bounded volume, no personal data, and nothing paid without the owner's yes.

**First, read the project's own rules.** If `.claude/fwd/analytics.md` exists in the project, read
it before anything else. It names the project's registry file, its caps and its dashboard
definitions, and wins where it conflicts with this skill.

## 1 · One closed event registry

Every event is declared in one typed registry. Sending an event that is not in it fails
typecheck. Each entry has:

- a **name**,
- its **required properties**, each a closed set (a union of literals, or a bucket),
- a **per-session cap** (section 2).

```ts
export const EVENT_VALUES = {
  item_created: { source: ['scratch', 'import'] },
  item_shared: {},
} as const;

export type Events = {
  [E in keyof typeof EVENT_VALUES]: {
    [P in keyof (typeof EVENT_VALUES)[E]]: (typeof EVENT_VALUES)[E][P][number];
  };
};

export const SEND_CAP: { [E in keyof Events]: number } = {
  item_created: 1,
  item_shared: 1,
};

export function track<E extends keyof Events>(name: E, props: Events[E]): void {
  /* section 2 */
}
```

Rules:

- **No property is typed `string`.** A free string is how a name, a query or an id rides along.
  Counts go in buckets (`1_to_10`, `11_to_100`), never the exact number.
- `SEND_CAP` is keyed on the registry, so an event without a cap fails typecheck too.
- A test asserts that no registry property is a bare string and that each built event stays
  inside its closed sets.
- Pageviews, pageleaves and clicks come from the SDK. Do not re-declare a pageview as a custom
  event: the same view counts twice.
- Name events `noun_verb` in the past tense. A new surface adds a value to a set, not a new event.

## 2 · Per-session caps

Volume stays bounded whatever the traffic, so the free tier holds. The cap is the guard; the
free-tier limit is the budget (section 5).

- **Counted** in memory, per event name, for the life of the page session: a `Map<string, number>`
  incremented on each send. Cleared on sign-out, so the next person on a shared device starts
  fresh.
- **Default cap is 1.** Raise it only for an action people repeat in runs (adding items), and
  then to a small number, such as 3.
- **At the cap, drop silently.** No throw, no log line per drop, no retry. Analytics never
  reaches the user.
- Every capture, including server-side, has a short timeout (a few seconds) and returns `false`
  on failure. No request waits on analytics.
- A server event with no session to count against (a webhook) has no cap, so it fires only on a
  trusted, already rate-limited path. An endpoint anyone can hit must not be a way to make
  analytics events.

## 3 · Privacy defaults

- **Discard the client IP.** Turn GeoIP off in the SDK config and on every server capture.
- **No personal data in properties or identity.** No name, email, address, query text or typed
  input. Identify with the auth provider's opaque id, or with a keyed hash of it on the server
  side. A person with no account gets a keyed hash or a random id, never their secret.
- **Redact URLs.** A `before_send` hook strips link tokens, query strings and hashes from every
  string before it leaves the browser.
- **Mark sensitive elements** so autocapture drops the click (the SDK's no-capture class).
- **Personless server events.** Server captures set `$process_person_profile: false`, so a late
  event cannot recreate a deleted person.
- **No session replay** unless the owner rules it in. Keep `disable_session_recording: true`.
- Honour Do Not Track. Load the SDK by dynamic `import()` so a dormant build never downloads it.
- **Dormant by default.** Analytics runs only with a key set and on the production hostname.
  Local, preview and staging builds send nothing, even if handed the key by mistake.

## 4 · Dashboards as code

Dashboard and insight definitions live in the repo, not in the vendor's UI.

- **Definitions** are one typed module: dashboards, each with named insights (the query and a
  description).
- **A pure planner** compares the definitions with what the project already has and returns one
  action per item: `create`, `update` or `keep`. Matching is by name. It never deletes.
- **A script** prints the plan and writes only with an explicit `--apply` flag. No flag is a
  dry run that makes GET requests only.
- **A manual workflow** runs the script. `workflow_dispatch` only, with no schedule and no push
  trigger, an `apply` boolean input that defaults to `false`, and a guard so only the copy on
  `main` runs. The vendor's personal API key reaches one step, the one that runs the script, as a
  repository secret. It is a different key from the public one the browser sends events with.
- **Idempotent.** A second apply reports every item `keep`. The planner treats keys the vendor
  adds as defaults as no difference, by checking that what the definition sets is contained in
  what came back.
- A PR that adds an event adds or updates its insight in the same PR.

## 5 · Vendor and cost

- **Default: PostHog, US cloud, free tier.** The free tier lists 1 million events a month for
  product analytics (checked on the vendor's pricing page; recheck before relying on it).
- **The free-tier limit is the budget; the caps are the guard.** Estimate monthly events as
  sessions times the sum of caps, plus autocapture and pageviews, and keep it well under the
  limit.
- **Spend above the free tier needs the owner's yes.** Never add a card, upgrade a plan or turn on
  a paid add-on without it. If volume approaches the limit, lower caps or drop autocapture
  first.
- Record the vendor, region and key names (not values) in the project's secrets inventory
  (`infra-setup`).

## 6 · Adopting it in a new project

- [ ] Create the PostHog project (US cloud) and set the public key and host as env vars. Production
      only.
- [ ] Add the registry, `SEND_CAP` and `track` (section 1), with the guard test.
- [ ] Add the SDK init with the privacy config (section 3): GeoIP off, replay off, `before_send`,
      hostname gate.
- [ ] Add the dashboards module, planner, script and workflow (section 4). Dry-run it, then
      apply once.
- [ ] Write `.claude/fwd/analytics.md`: registry path, caps, dashboard module, key names.
- [ ] Add the budget line (section 5) to the infra record.

## 7 · What to measure first

One funnel of 3 to 5 steps, from a stranger's first view to the first real use of the product:

1. Landing view (the SDK's pageview, filtered by path).
2. Sign-up started.
3. Account created (server side).
4. First core action (the event the product exists for).
5. A second-day return, if retention matters yet.

Build that funnel as the first dashboard, then add events only when a question needs one. Count
events, not people, where ids are not shared across steps.
