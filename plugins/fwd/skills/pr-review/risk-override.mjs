// Which paths make a PR risky, and the PR body's declaration that a path-risky PR is not.
//
// Split out of pr-gate.mjs so the rule can be tested without GitHub (the gate runs on import).
//
// WHY. The owner's rule (2026-10-30) is that a PR is risky only when its diff CHANGES writes or
// behaviour in the DB or migrations, auth, payment charging or refunds, API or cron routes,
// security, or anything destructive. Reading or displaying payment data, copy, UI and tests are not
// risky, whatever folder the files sit in. The gate can only read paths, so a display-only change to
// a `credits` model or a `credits` copy file read as payments code and demanded the risky-PR review.
//
// THE OVERRIDE. The lane that knows what the diff does writes a `## Risk: not risky` section in
// the PR body, giving the reason. When the reason is real (the same placeholder test as
// `## Claude review`, claude-review.mjs), a path-risky PR is treated as not risky: it takes a
// recorded Claude review. The override is IGNORED, and the PR stays risky, when the
// diff carries a hard-risky signal (HARD_RISKY below, or a destructive diff): there a wrong
// declaration costs data, money or access, so a lane's word is not enough.

import { isDoc } from './classify.mjs';
import { sectionState } from './claude-review.mjs';

// ---- risky paths -------------------------------------------------------------
// Each part is named so HARD_RISKY can reuse it. RISKY_PATH is their union.
const MIGRATION_SCHEMA = /(^|\/)(drizzle|migrations?|prisma|schemas?)(\/|\.)/i;
const DB_LAYER = /(^|\/)db(\/|\.)/i;
const AUTH_SESSION =
  /(^|\/)(auth|oauth|session)(\/|[-_.])|(^|\/)(proxy|middleware)\.[jt]s$/i;
// A `tokens` segment is security code UNLESS it is a design-token file: a stylesheet or data file
// (css, scss, sass, less, json) at or under a `tokens` folder, or named `tokens.<ext>`, with no
// auth, api, server, session, security or secret folder above it. Code files (ts, js, ...) named
// `tokens` stay risky, as does anything ambiguous.
const DESIGN_TOKEN_REST = String.raw`(?:\/.*)?\.(?:css|scss|sass|less|json)$`;
const UNDER_SERVER_DIR = String.raw`(?<=(?:^|\/)(?:auth|oauth|session|api|server|security|secrets?)\/(?:.*\/)?)`;
const SECURITY = new RegExp(
  String.raw`(^|\/)(security|crypto|secrets?|passwords?|csrf|jwt|encrypt\w*|(?:${UNDER_SERVER_DIR}tokens?|tokens?(?!${DESIGN_TOKEN_REST})))(\/|[-_.])` +
    String.raw`|(^|\/)[^/]*[-_.]tokens?\.[cm]?[jt]sx?$`,
  'i',
);
const PAYMENTS = /(^|\/)(billing|payments?|credits?|stripe)(\/|[-_.])/i;
const WEBHOOKS = /(^|\/)webhooks?(\/|[-_.])/i;
// API and cron route handlers: an `api/` tree, a `routes/` or `cron/` folder, or a Next.js
// `route.ts` handler file.
const ROUTES =
  /(^|\/)(app|pages)\/api\/|(^|\/)(routes?|crons?)\/|(^|\/)route\.[cm]?[jt]s$/i;

export const RISKY_PATH = new RegExp(
  [
    MIGRATION_SCHEMA,
    DB_LAYER,
    AUTH_SESSION,
    SECURITY,
    PAYMENTS,
    WEBHOOKS,
    ROUTES,
  ]
    .map((r) => r.source)
    .join('|'),
  'i',
);

/**
 * The risky runtime paths among a PR's files: each `{ filename, previous_filename? }` (a rename OUT
 * of a risky path still touches it), less documentation, tests and the `nonRuntime` paths the gate
 * proved do not change what runs. The gate (pr-gate.mjs) and the escape sweep (escape-sweep.mjs)
 * both read risk through this one function.
 */
export const riskyPathsOf = (files, nonRuntime = new Set()) =>
  files
    .flatMap((f) => [f.filename, f.previous_filename].filter(Boolean))
    .filter(
      (p) =>
        !isDoc(p) &&
        !nonRuntime.has(p) &&
        !/\.(test|spec)\.[cm]?[jt]sx?$/.test(p) &&
        RISKY_PATH.test(p),
    );

// The signals a `## Risk: not risky` declaration cannot override. A destructive diff is the fifth,
// read by the gate (pr-gate.mjs, DESTRUCTIVE) and passed in.
// Payments, the DB layer and security paths are left out ON PURPOSE (owner ruling 2026-10-30): a file
// there can be read-only or display-only, which is the case the declaration exists for. Clearing
// one is the lane's written claim that the diff changes no charge, refund or write, and the gate
// prints that claim; it cannot check it.
export const HARD_RISKY = [
  { name: 'migration/schema', pattern: MIGRATION_SCHEMA },
  { name: 'API/cron route', pattern: ROUTES },
  { name: 'auth/session/middleware/proxy', pattern: AUTH_SESSION },
  { name: 'webhook', pattern: WEBHOOKS },
];

/** The heading lanes write, exactly. */
export const NOT_RISKY_TITLE = '## Risk: not risky';
const NOT_RISKY_HEADING = /^##[ \t]+Risk:[ \t]*not risky\b([^\n]*)$/im;

/** The hard-risky signals in a PR: `destructive diff`, or `<name>: <path>` per matching path. */
export function hardRiskySignals(paths, destructive) {
  const signals = destructive ? ['destructive diff'] : [];
  for (const p of paths) {
    const hit = HARD_RISKY.find(({ pattern }) => pattern.test(p));
    if (hit) signals.push(`${hit.name}: ${p}`);
  }
  return signals;
}

/**
 * What the PR body's `## Risk: not risky` section does to a PR the paths call risky.
 * `riskyPaths` are the gate's risky runtime paths (tests, docs and non-runtime files already
 * dropped); `destructive` is whether the diff is destructive.
 *
 * Returns `{ declared, applied, reason, ignored, signals }`: `declared` when the heading exists,
 * `applied` when the PR is to be treated as not risky, `reason` the section's text, and `ignored`
 * the reason a declaration did not apply (null when it applied or was never made).
 */
export function riskOverride(body, { riskyPaths, destructive }) {
  const s = sectionState(body, NOT_RISKY_HEADING);
  const none = {
    declared: false,
    applied: false,
    reason: '',
    ignored: null,
    signals: [],
  };
  if (!s.present) return none;
  const base = { ...none, declared: true, reason: s.text };
  if (!s.recorded)
    return {
      ...base,
      ignored: 'the reason is empty or a placeholder (pending, TBD, n/a)',
    };
  if (!destructive && riskyPaths.length === 0)
    return { ...base, ignored: 'not needed: no risky path in this diff' };
  const signals = hardRiskySignals(riskyPaths, destructive);
  if (signals.length > 0)
    return {
      ...base,
      signals,
      ignored: `hard-risky signal (${signals.slice(0, 3).join(', ')}); a declaration cannot clear it`,
    };
  return { ...base, applied: true };
}

// ---- Opus-worthy paths ---------------------------------------------------------
// The narrower set run-project's model-pick.mjs reads from a PR's PLANNED paths: money, auth,
// migrations and security. The DB layer, webhooks and API/cron routes are risky for review but do
// not by themselves call for Opus. Built from the parts above, so there is one definition of each.
export const MODEL_RISKY = [
  { category: 'money', pattern: PAYMENTS },
  { category: 'auth', pattern: AUTH_SESSION },
  { category: 'migrations', pattern: MIGRATION_SCHEMA },
  { category: 'security', pattern: SECURITY },
];

/** The first MODEL_RISKY category a runtime path falls in, or null. Docs and tests never count. */
export const modelRiskOf = (path) =>
  isDoc(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)
    ? null
    : (MODEL_RISKY.find(({ pattern }) => pattern.test(path))?.category ?? null);
