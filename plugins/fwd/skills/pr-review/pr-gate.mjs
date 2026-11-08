#!/usr/bin/env node
// The pr-review rules, computed instead of remembered.
//
// WHY THIS EXISTS. The rules were prose in a skill, read once at the start of a
// turn and applied from memory for hours afterwards. The author of that skill
// then broke three of its rules in a single PR — merged a PR eight rounds after
// its bar was met, patched one surface for three consecutive rounds instead of
// making the scope decision, and added new files at round four. None of that was
// disagreement with the rules; it was not knowing, in the moment, what round it
// was or what the last three rounds had landed on.
//
// So the state is measured from GitHub and printed. Every rule that can be
// decided from data is decided here rather than by recall.
//
//   node pr-gate.mjs <pr> [--action merge|rerequest] [--repo owner/name]
//
// Exit 0 when the action is allowed, 1 when a rule forbids it. `--action` with
// no value reports state without judging an action.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isAnsweredIn,
  isDeclinedIn,
  mentions,
  parseDocSync,
  parseSettled,
} from './settled.mjs';
import {
  claudeReviewState,
  copilotOffBar,
  copilotOffDoor,
  COPILOT_OFF_HINT,
  RECORD_HINT,
} from './claude-review.mjs';
import { NOT_RISKY_TITLE, RISKY_PATH, riskOverride } from './risk-override.mjs';
import {
  commentOnlyHunks,
  isCommentOnlyChange,
  isDoc,
  isDocOnlyChange,
  isGenerated,
  isHandoff,
  isToolingConfig,
  isVersionOnlyChange,
} from './classify.mjs';
import { markStaleRounds } from './stale-rounds.mjs';
import { ciProblemsOf } from './ci-state.mjs';
import { ledgerPath } from './ledger-path.mjs';
import { copyOnly, diminishingReturns, findingsIn } from './rounds.mjs';
import {
  checkoutIsPr,
  entryMatchesRepo,
  refPath,
  repoFromRemoteUrl,
  sameRepo,
} from './git-remote.mjs';
import { parsePages } from './pages.mjs';
import { fixPaths, fixWeight } from './fix-scope.mjs';

const args = process.argv.slice(2);
const pr = args.find((a) => /^\d+$/.test(a));
const action = args.includes('--action')
  ? args[args.indexOf('--action') + 1]
  : null;
const repoArg = args.includes('--repo')
  ? args[args.indexOf('--repo') + 1]
  : null;

const run = (args) =>
  execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const gh = (path) => parsePages(run(['api', path, '--paginate']));

// `--audit-reviewed` lists every merged PR carrying a `## Reviewed by` header.
// That header halves the merge bar and is the ONE input the gate cannot verify:
// GitHub forbids approving your own PR and reading one creates no review event,
// so a real human review and a fabricated header are indistinguishable over the
// API. Agents must not write it (§8). This makes the claims auditable instead.
if (args.includes('--audit-reviewed')) {
  // `--repo o/r`, or the bare `o/r` SKILL.md documents (`--audit-reviewed [owner/name]`).
  const r =
    repoArg ??
    args.find((a) => /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(a)) ??
    execFileSync(
      'gh',
      ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
      { encoding: 'utf8' },
    ).trim();
  // `gh api ...?state=closed --paginate` concatenates one JSON array per page,
  // which does not parse. `gh pr list --json` returns one array however many
  // pages it read.
  const prs = JSON.parse(
    execFileSync(
      'gh',
      [
        'pr',
        'list',
        '-R',
        r,
        '--state',
        'merged',
        '--limit',
        '200',
        '--json',
        'number,body,mergedAt',
      ],
      { encoding: 'utf8', maxBuffer: 64e6 },
    ),
  );
  const hits = [];
  for (const p of prs) {
    const m = /^##\s+Reviewed by\s+(.+?)\s*$/im.exec(p.body ?? '');
    if (!m) continue;
    // Paginated: more than one page of reviews is several JSON arrays back to back.
    const rounds = gh(`repos/${r}/pulls/${p.number}/reviews`).filter(
      (v) => v.user?.type === 'Bot',
    ).length;
    hits.push({
      n: p.number,
      who: m[1].trim(),
      rounds,
      merged: (p.mergedAt || '').slice(0, 10),
    });
  }
  console.log(`${hits.length} merged PR(s) in ${r} claim a human review.`);
  console.log(
    'A claim here cannot be checked against the API — confirm each against your own memory.\n',
  );
  for (const h of hits.sort((a, b) => b.n - a.n)) {
    const flag =
      h.rounds <= 1
        ? '  <-- merged on ONE round; the header was load-bearing'
        : '';
    console.log(
      `  #${h.n}  ${h.merged}  ${h.rounds} round(s)  "${h.who}"${flag}`,
    );
  }
  process.exit(0);
}
if (!pr) {
  console.error(
    'usage: pr-gate.mjs <pr> [--action merge|rerequest] [--repo owner/name]',
  );
  process.exit(2);
}

// An explicit `--repo` always decides, and the working directory is never consulted for it.
// Without one, the repository is the working directory's, as `gh` itself resolves it. Outside any
// checkout there is none, and the gate stops (exit 1, so the hook denies) with the reason in one
// line rather than a stack trace whose first line, "not a git repository", read as a broken hook.
let repo = repoArg;
if (!repo) {
  try {
    repo = JSON.parse(
      execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ).nameWithOwner;
  } catch {
    repo = null;
  }
  if (!repo) {
    console.log(
      `cannot tell which repository PR #${pr} is in: ${process.cwd()} is not a checkout of one. ` +
        'Name it with --repo owner/name.',
    );
    process.exit(1);
  }
}

const [prData] = gh(`repos/${repo}/pulls/${pr}`);
const reviews = gh(`repos/${repo}/pulls/${pr}/reviews`).filter(
  (r) => r.user?.type === 'Bot',
);
const inline = gh(`repos/${repo}/pulls/${pr}/comments`);
const files = gh(`repos/${repo}/pulls/${pr}/files`);

// Files whose change is shown not to touch what runs (classify.mjs): a top-level version bump in
// plugin.json or package.json, or a script edit whose every changed line is a comment. The comment
// check needs the head file's text, to see a template literal opened above a hunk; when the API
// cannot return it, the file stays runtime. These score as prose: a doc PR that rewords a comment
// or bumps the plugin version still needs one round, not two.
const nonRuntime = new Set();
for (const f of files) {
  if (isVersionOnlyChange(f)) {
    nonRuntime.add(f.filename);
    continue;
  }
  if (!commentOnlyHunks(f.patch)) continue;
  try {
    const text = execFileSync(
      'gh',
      [
        'api',
        '-H',
        'Accept: application/vnd.github.raw',
        `repos/${prData.head.repo?.full_name ?? repo}/contents/${refPath(f.filename)}?ref=${prData.head.sha}`,
      ],
      {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    if (isCommentOnlyChange(f, text)) nonRuntime.add(f.filename);
  } catch {
    // No head text: the change cannot be shown to be comment-only, so it stays runtime.
  }
}

// ---- findings ---------------------------------------------------------------
// A finding is an inline comment or a suppressed one. Suppressed comments live
// in the review BODY only — the comments API never returns them — and a round
// judged without them reads clean while holding real bugs.
const SUPPRESSED = /\*\*([^*\s]+\.\w+):(\d+)\*\*/g;
const errored = (body) => /encountered an error/i.test(body ?? '');

const reviewedRounds = reviews.map((review, index) => {
  const previous = reviews[index - 1]?.submitted_at ?? '1970-01-01T00:00:00Z';
  // A REPLY is not a finding. The author's own answer to a thread ("Fixed in …") is an inline
  // comment too, and counted as one it lands in whichever round's window it was written in: on
  // one PR, a reply to round 2 made a clean round 3 read as one finding on the same file, and
  // tripped §7's three-round rule over a file review had stopped raising.
  const newInline = inline.filter(
    (c) =>
      !c.in_reply_to_id &&
      c.created_at > previous &&
      c.created_at <= review.submitted_at,
  );
  const suppressed = [...(review.body ?? '').matchAll(SUPPRESSED)].map(
    (m) => m[1],
  );
  // The first line of each finding, kept so the gate can show what the PREVIOUS
  // round said next to this one. The three-round rule keys on FILE, and a
  // repeat-class defect lands on different files with one cause — invisible
  // unless the texts sit side by side.
  const texts = [
    ...newInline.map((c) => (c.body ?? '').split('\n')[0]),
    ...[...(review.body ?? '').matchAll(/^\* (.+)$/gm)].map((m) => m[1]),
  ].map((t) => t.replace(/`/g, '').slice(0, 120));
  const paths = [...new Set([...newInline.map((c) => c.path), ...suppressed])];
  // Findings per path, so a Settled decline can answer one finding and not the whole file.
  const findings = {};
  for (const p of [...newInline.map((c) => c.path), ...suppressed])
    findings[p] = (findings[p] ?? 0) + 1;
  return {
    n: index + 1,
    sha: review.commit_id,
    at: review.submitted_at,
    errored: errored(review.body),
    // The header's own verdict. It is NOT a gate on its own — a 🟢 over real
    // unresolved findings is why that rule exists — but it is signal about how
    // hard the reviewer is pushing, and `Changes recommended` is the only one
    // that claims something must change before merge.
    pressing: /Changes recommended/i.test(review.body ?? ''),
    inlineCount: newInline.length,
    paths,
    findings,
    texts,
    count: paths.length,
  };
});

// ---- rounds that reviewed a head already gone -------------------------------
// §3: a review of a head the author had already pushed past counts for nothing. Checking only the LAST round
// against the current head missed a stale round followed by a fresh one (one PR: round 5 landed on the
// head before a force push and was scored clean, so 5 and 6 read as a two-round streak). Every round is judged
// against the head the remote held when it was submitted. See stale-rounds.mjs.
const pushTimes = () => {
  const pushes = [];
  try {
    for (const e of gh(`repos/${repo}/issues/${pr}/timeline`)) {
      if (e.event === 'head_ref_force_pushed' && e.commit_id)
        pushes.push({ sha: e.commit_id, at: e.created_at });
    }
  } catch {
    // No timeline: every push time below comes from check suites.
  }
  const firstReview = reviews[0]?.submitted_at;
  const candidates = new Set([
    ...reviews.map((r) => r.commit_id),
    prData.head.sha,
  ]);
  try {
    for (const c of gh(`repos/${repo}/pulls/${pr}/commits`)) {
      if (firstReview && (c.commit?.committer?.date ?? '') >= firstReview)
        candidates.add(c.sha);
    }
  } catch {
    // The reviewed shas and the head are enough to judge the common case.
  }
  const forced = new Set(pushes.map((p) => p.sha));
  for (const sha of candidates) {
    if (!sha || forced.has(sha)) continue;
    try {
      // A check suite is created when its sha is pushed, so the earliest one is the push time.
      const at = run([
        'api',
        `repos/${repo}/commits/${sha}/check-suites`,
        '--jq',
        '[.check_suites[].created_at] | min',
      ]).trim();
      if (at && at !== 'null') pushes.push({ sha, at });
    } catch {
      // Unknown push time: markStaleRounds never marks a round on an unknown.
    }
  }
  return pushes;
};
const rounds = reviews.length
  ? markStaleRounds(reviewedRounds, pushTimes())
  : reviewedRounds;

// ---- declined findings ------------------------------------------------------
// A finding the author declined on the facts, recorded in the PR body's
// `## Settled` section, must not go on classifying a round as substantive.
//
// It could before, and it cost a merge. On one PR round 11 held one doc
// finding, two probe findings and a test-comment finding — all soft — plus one
// claiming a surface was untested when five mutation-checked tests covered it.
// That single wrong finding made the round substantive, held the streak at
// zero, and pushed the merge onto §7's hard stop instead of the bar. A finding
// that is wrong should not be able to block a merge for ever.
//
// Read from the BODY rather than taken as a flag, because §6 already requires
// the decline to be written there with its reason: the safeguard is that a
// human can see every path this discounts. Printed below for the same reason —
// never silent.
//
// Anchored on real file extensions rather than on "a dot inside backticks",
// which also swallowed `page.evaluate` and would swallow any API call written
// the same way. A decline has to NAME THE FILE THE FINDING LANDED ON — naming
// the test that disproves it is not the same file, and will not discount it.
//
// ROUND-SCOPED (settled.mjs). An entry discounts its file only in the round(s)
// its line names, or, naming none, only in the first round that flagged the
// file. It used to discount the file in every later round and faked a green
// twice by swallowing a new real finding on a Settled file.
const settled = parseSettled(prData.body);

// ---- classification ---------------------------------------------------------
// What a path can break decides whether fixing it earns another round (isDoc, isHandoff: classify.mjs).
const isCopyPath = (p) => p.startsWith('src/lib/copy/');
const isTooling = (p) =>
  p.startsWith('scripts/') || /\.test\.\w+$/.test(p) || /probe/.test(p);
// A PR whose product IS the script: tooling paths are its production code.
// Requires at least one tooling file: a docs-only PR satisfies `every` vacuously
// and was labelled "scripts/ IS this PR's product" over a single .md.
// Build and test config (CI workflows, package.json, the lockfile, a test-runner
// config) is how a tooling PR wires its script in; it names no product surface.
// Without this, a clock-shift PR touching ci.yml, package.json and vitest.config.ts
// beside its script scored the script's findings as soft tooling.

const productIsTooling =
  files.some((f) => isTooling(f.filename)) &&
  files.every(
    (f) =>
      isTooling(f.filename) || isDoc(f.filename) || isToolingConfig(f.filename),
  );
// A PR whose product IS the prose — a copy module, a brief, a property table.
// Its findings still score soft (§9 buys it one round, not two), but "soft" is a
// statement about ROUNDS, never about value: one such PR carried twelve factual
// errors that every reader would have seen. Printed so the distinction is made.
const productIsProse =
  files.length > 0 &&
  files.every(
    (f) =>
      isDoc(f.filename) || isCopyPath(f.filename) || nonRuntime.has(f.filename),
  );

const classify = (p) =>
  isHandoff(p)
    ? 'handoff'
    : isDoc(p) || nonRuntime.has(p)
      ? 'doc'
      : isTooling(p)
        ? productIsTooling
          ? 'product'
          : 'tooling'
        : 'product';

// A path is declined when `## Settled` names that exact file, or names it by
// basename — a PR body says `novelty.ts`, not `src/lib/discovery/novelty.ts`.
// ---- doc-sync ---------------------------------------------------------------
// §5 says doc-sync findings do not reset the counter, and until now the gate
// could not honour it: it cannot tell a comment-accuracy fix from a logic one.
// A `## Doc-sync` section names the paths whose findings were comment, naming or
// PR-body accuracy only. One PR spent two extra rounds because round 4's single
// finding was a parameter named `seedable` while the caller passed `tickable`.
// Entries are round-scoped like `## Settled` (see settled.mjs): a listed file's
// LATER findings still count, or one listing hides every round after it.
const docSynced = parseDocSync(prData.body);

// ---- human review ----------------------------------------------------------
// An explicit, opt-in signal from the user that they reviewed this PR
// themselves, in the same spirit as `## Settled`: a heading in the PR body,
// naming the reviewer. Deliberately NOT a path heuristic — a rule that relaxed
// the bar for `src/components/**` would silently downgrade real code that
// happens to live in a components directory.
//
// NOT a security boundary, and nothing here pretends otherwise: an agent that
// writes the PR body can write this block, exactly as it can write a `## Settled`
// entry. What it buys is VISIBILITY — the claim is in the PR body forever, the
// gate prints it, and a later reader can see why the bar was one round.
const humanReview = /^##\s+Reviewed by\s+(.+?)\s*$/im.exec(prData.body ?? '');
const humanReviewer = humanReview?.[1]?.trim() || null;
// OWNER RULING 2026-10-30: when the org's monthly Copilot AI-credit budget is exhausted, reviews stop
// landing, and code PRs merge on green CI with no round until it resets. The PR body records it under
// `## Copilot budget stop` (one line: the date and the failed request). Every use is printed.
const budgetStop = /^##\s+Copilot budget stop\s*$/im.test(prData.body ?? '');

// ---- destructive paths -------------------------------------------------------
// §8 gives these clean-after-clean and NOTHING relaxes that — not doc-only, not
// copy-only, not a human review. A planner that reported "nothing changed" while
// ignoring rows the apply path replaced wholesale was found at round 9, after a
// round 8 that returned nothing at all.
// Narrow on purpose. The first version matched Tailwind's `truncate` class and
// called a presentational tile destructive — and a false positive here silently
// denies the human-reviewed path, which is the failure nobody would notice.
// SQL verbs require their object; JS deletes require a call; prose cannot match.
const DESTRUCTIVE = new RegExp(
  [
    'delete\\s+from\\s+\\w', // delete from <table>
    'drop\\s+(table|column|index)\\s+\\w',
    'truncate\\s+table\\s+\\w', // not Tailwind's class, not "sections truncate at four"
    'replaceCollection\\s*\\(',
    '\\brm\\s+-rf\\b',
    'deleteMany\\s*\\(',
    '\\.delete\\s*\\(', // drizzle db.delete(...)
    'fs\\.(unlink|rm)\\s*\\(',
  ].join('|'),
  'i',
);
// Only ADDED lines in runtime files: a deletion of a destructive line is the
// opposite of a destructive change, and prose describing one is not one.
// Product tree only. A probe deleting its own fixture in a `finally` is the
// discipline this repo requires, not a risk to user data — and counting it
// denied the human-reviewed path to three PRs whose product deletes nothing.
// Comments are stripped: "Money sections truncate at four" is prose in a .tsx.
const addedRuntime = (f) =>
  !isDoc(f.filename) &&
  !isHandoff(f.filename) &&
  !isTooling(f.filename) &&
  (f.patch ?? '')
    .split('\n')
    .filter((l) => l.startsWith('+'))
    .map((l) => l.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, ''))
    .filter((l) => !/^\+\s*\*/.test(l))
    .join('\n');
const destructivePaths = files
  .filter(
    (f) =>
      // A migration directory's prose (its README) is documentation, not a migration.
      (/migrations?\//.test(f.filename) && !isDoc(f.filename)) ||
      DESTRUCTIVE.test(addedRuntime(f) || ''),
  )
  .map((f) => f.filename);
const destructive = destructivePaths.length > 0;

// OWNER RULING 2026-10-30: Copilot reviews only RISKY code PRs, one round at Lite effort. Risky means
// the diff is destructive (above) or touches a path where a defect costs data, money or access:
// migrations and schema, the DB layer, auth/session/proxy, payments/credits/billing, API and cron
// routes, or security code (RISKY_PATH, risk-override.mjs). Every other code PR takes a Claude review
// instead, recorded in the PR body under `## Claude review`, and merges on green CI.
// A path is not the rule: a display-only change to a credits file is not payments code. The PR body's
// `## Risk: not risky` section, with a real reason, clears a path-risky PR, unless the diff carries a
// hard-risky signal (risk-override.mjs, HARD_RISKY). Every declaration is printed, applied or not.
const riskyPaths = files
  // A rename OUT of a risky path still touches it.
  .flatMap((f) => [f.filename, f.previous_filename].filter(Boolean))
  .filter(
    (p) =>
      !isDoc(p) &&
      !nonRuntime.has(p) &&
      !/\.(test|spec)\.[cm]?[jt]sx?$/.test(p) &&
      RISKY_PATH.test(p),
  );
const pathRisky = destructive || riskyPaths.length > 0;
const override = riskOverride(prData.body, { riskyPaths, destructive });
const risky = pathRisky && !override.applied;
// The heading alone is not a review: a section that says only "(pending)", TBD or nothing does not
// count (claude-review.mjs has the rule).
const claudeReview = claudeReviewState(prData.body);
const claudeReviewed = claudeReview.recorded;
const claudePlaceholder = claudeReview.present && !claudeReview.recorded;
// OWNER RULING 2026-11-08: Copilot is off. `## Copilot off` plus a Claude review recording both
// `/code-review` and the `Checklist pass:` meets a risky PR's bar with no Copilot round, the same way
// the budget stop does; with the heading present, no Copilot request is allowed (claude-review.mjs).
const copilotOff = copilotOffDoor(prData.body);
// Set only on a risky PR that declares the heading; the reason a shut door is shut.
const doorShut = copilotOff.declared && risky && !copilotOff.opens;
// Test, probe, script or copy-only PRs take no review at all, like doc-only ones (owner ruling 2026-10-30).
// Narrower than isTooling: no package.json, lockfile or CI config (a dependency bump is code), and a
// probe counts only as a directory, never a runtime path that happens to say "probe".
const isTestOrScript = (p) =>
  p.startsWith('scripts/') ||
  /(^|\/)(tests?|__tests__|e2e|probes?)\//.test(p) ||
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);
const noReview =
  !pathRisky &&
  files.every(
    (f) =>
      isTestOrScript(f.filename) || isCopyPath(f.filename) || isDoc(f.filename),
  ) &&
  files.some((f) => isTestOrScript(f.filename) || isCopyPath(f.filename));

// Errored rounds are skipped when finding the round that first flagged a file,
// the same as everywhere else they are scored.
const isDeclined = (p, n) =>
  isDeclinedIn(
    settled,
    p,
    n,
    rounds.filter((r) => !r.errored),
  );
// Doc-sync's bare entries are matched against fresh rounds only: a stale review counts for
// nothing (§3), so the round that first flagged a file must not be one. Settled keeps its own
// rule. Settled and Doc-sync lines are counted together against the round's findings.
const isAnswered = (p, n) =>
  isAnsweredIn(
    [
      { entries: settled, rounds: rounds.filter((r) => !r.errored) },
      {
        entries: docSynced,
        rounds: rounds.filter((r) => !r.errored && !r.staleAtSubmit),
      },
    ],
    p,
    n,
  );
const roundWeight = (round) => {
  const counts = round.paths.some(
    (p) =>
      classify(p) === 'product' && !isAnswered(p, round.n) && !isHandoff(p),
  );
  if (!counts) return 'soft';
  // A reviewer that did not say `Changes recommended`, and raised nothing inline,
  // is describing rather than blocking: every finding it had, it suppressed. That
  // is a round worth READING — the findings still get fixed — but not one worth
  // paying another round for. `Changes recommended` always counts.
  if (!round.pressing && round.inlineCount === 0) return 'soft';
  return 'substantive';
};

// The remote ref for this PR's head branch, asked once and used by both the
// staleness check and the push-landed check below. `origin` answers only when it IS the PR's
// head repository: run with `--repo` from a checkout of another repo, a branch of the same
// name there handed back an unrelated SHA as the PR's head, which marked a fresh review stale
// and could open the soft-fixed exception. Otherwise the API's ref for the head repo answers.
let originRepo = null;
try {
  originRepo = repoFromRemoteUrl(
    execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
  );
} catch {
  // Not a git checkout.
}
const originIsHead = sameRepo(originRepo, prData.head.repo?.full_name);
let refHead = null;
try {
  if (originIsHead) {
    const out = execFileSync(
      'git',
      ['ls-remote', 'origin', `refs/heads/${prData.head.ref}`],
      {
        encoding: 'utf8',
        timeout: 15000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
    refHead = out.split(/\s+/)[0] || null;
  } else if (prData.head.repo?.full_name) {
    const [ref] = gh(
      `repos/${prData.head.repo.full_name}/git/ref/heads/${refPath(prData.head.ref)}`,
    );
    refHead = ref?.object?.sha ?? null;
  }
} catch {
  // Network, auth, or a deleted head branch: fall back to the PR's own sha.
}

// ---- the rules --------------------------------------------------------------
// `pulls/N` lags the ref by seconds. That lag reported a push as missing (see the
// push-landed check) and, in the other direction, reported a review as having
// "seen the current head" when an amend had moved it moments earlier — which
// would hand §3 a stale round to triage as fresh. The ref decides.
const head = refHead ?? prData.head.sha;
const last = rounds.at(-1);
const stale = last && last.sha !== head;
const successful = (r) => r.count === 0 || roundWeight(r) === 'soft';
// Errored reviews are dropped entirely rather than counted as unsuccessful. They
// produce no findings, so they prove nothing in either direction — and counting
// one against the streak makes a Copilot outage indistinguishable from a PR with
// problems. Three in a row cost another agent 25 minutes of backoff this week.
const scored = rounds.filter((r) => !r.errored && !r.staleAtSubmit);

// §8's diminishing returns. See rounds.mjs.
const {
  recent,
  total: recentFindings,
  applies: diminishing,
} = diminishingReturns(scored, destructive);
const trailingClean = [...scored].reverse().findIndex((r) => !successful(r));
const cleanStreak = trailingClean === -1 ? scored.length : trailingClean;

// Three-round rule: one path drawing findings in three consecutive SCORED rounds. Every §7 count
// skips stale and errored reviews, or a discarded one hides the advance warning.
const lastThree = scored.slice(-3);
const repeated =
  lastThree.length === 3
    ? lastThree[0].paths.filter(
        (p) => lastThree[1].paths.includes(p) && lastThree[2].paths.includes(p),
      )
    : [];

// Files this PR CREATES, as opposed to ones it edits. The provenance rule below
// reads this too.
const createdHere = files
  .filter((f) => f.status === 'added')
  .map((f) => f.filename);

// Files first seen after round 3 — new review surface added mid-cycle.
//
// Asked per file, from that file's own commit history, and NOT from
// `compare(roundThreeSha...head)`. That compare resolves through a merge base,
// so once the branch is rebased — which the pre-push gate (pr-review §5) requires
// on every push — it reports every file the PR creates as "added", whenever it was
// really added. On one PR it named a probe and an inventory that had both
// been there since the PR opened, in all eight gate runs from round 4 on, and
// the warning had to be discounted by hand every time. A rule that cries wolf
// on a mandated workflow teaches the habit this tool exists to break.
//
// Commit AUTHOR dates survive a rebase; committer dates do not. Only files the
// PR creates can have been added late, so the loop is over those alone.
const roundThreeAt = scored[2]?.at;
let addedLate = [];
if (roundThreeAt) {
  for (const filename of createdHere) {
    try {
      const commits = gh(
        `repos/${repo}/commits?sha=${encodeURIComponent(head)}&path=${encodeURIComponent(filename)}&per_page=100`,
      );
      const first = commits
        .map((c) => c.commit?.author?.date)
        .filter(Boolean)
        .sort()[0];
      if (first && first > roundThreeAt) addedLate.push(filename);
    } catch {
      // A file whose history cannot be read is not evidence of anything.
    }
  }
}

// Findings landing on code this PR itself created, three rounds running.
//
// The three-round rule watches ONE PATH, and that is what it missed on
// On one PR, rounds 4 to 11 were almost entirely about supporting code that did
// not exist when the PR opened, but the findings moved between a component, one
// probe and then another, so no single path ever drew three in a row. Grouped by
// provenance instead, it is one line and it is visible at round 6.
const createdSet = new Set(createdHere);
const lastThreeOnNew =
  lastThree.length === 3 &&
  lastThree.every((r) => r.paths.some((p) => createdSet.has(p)));

// ---- did the push actually happen? -----------------------------------------
// A chained `git rebase && git push && gh api …` short-circuits silently: one
// agent hit a real rebase conflict, the chain stopped, and the success line
// printed anyway — two rounds of wall-clock spent reviewing code that was never
// uploaded. Same shape as §1's "a 200 is not proof".
//
// Compared only when the local branch IS the PR's head branch: this script is
// often run from another worktree, where a mismatch means nothing.
let localHead = null;
let localBranch = null;
try {
  // stderr dropped: outside a checkout, git's "not a git repository" is the expected answer, and
  // printed, it led the hook's denial and read as the reason for it.
  localBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  localHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {
  // Not a git repo, or a detached HEAD — the check simply does not apply.
}
// The local branch is the PR's only when the checkout is the PR's as well: `origin` is the head
// repository, or the branch tracks the head repository or the PR's own ref (a fork PR checked out
// inside the base repository). The same branch name in an unrelated repo is a different branch.
const gitConfig = (key) => {
  try {
    return execFileSync('git', ['config', '--get', key], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
};
const upstream = localBranch ? gitConfig(`branch.${localBranch}.remote`) : null;
const upstreamUrl =
  upstream && !upstream.includes('/') && !upstream.includes(':')
    ? gitConfig(`remote.${upstream}.url`)
    : upstream;
const mergeRef = localBranch ? gitConfig(`branch.${localBranch}.merge`) : null;
// Each way of being the PR's checkout carries its own repository condition: the PR's branch name
// in a checkout of the head repository, or the PR's own pull ref tracked from its base repository.
const onHeadBranch = Boolean(
  localBranch &&
  checkoutIsPr({
    branchMatches: localBranch === prData.head.ref,
    originRepo,
    upstreamRepo: repoFromRemoteUrl(upstreamUrl),
    mergeRef,
    headRepo: prData.head.repo?.full_name,
    baseRepo: prData.base.repo?.full_name,
    pr,
  }),
);

// The REF is the authority on whether a push landed, not the PR API: `pulls/N`
// lags the ref by seconds and reported a false negative on a push that had in
// fact landed. Ask the remote directly, and fall back to the PR's own sha only
// when the remote cannot be reached.
const remoteHead = onHeadBranch ? refHead : null;
const pushTarget = remoteHead ?? prData.head.sha;
const unpushed = Boolean(onHeadBranch && localHead && localHead !== pushTarget);

const docOnly = isDocOnlyChange(files, nonRuntime);
const changed = files.length;
const lines = files.reduce((n, f) => n + f.additions + f.deletions, 0);
const openedHours = (Date.now() - Date.parse(prData.created_at)) / 3_600_000;

// ---- report -----------------------------------------------------------------
const say = (ok, rule, detail) =>
  console.log(`${ok ? 'ok  ' : 'STOP'}  ${rule}  ${detail}`);
const warn = (rule, detail) => console.log(`warn  ${rule}  ${detail}`);
const blocks = [];

// A file is prose or generated, never both: `docs/drizzle/meta/…` must leave the runtime count once.
const proseLines = files
  .filter(
    (f) =>
      !isGenerated(f.filename) &&
      (isDoc(f.filename) ||
        isHandoff(f.filename) ||
        isCopyPath(f.filename) ||
        nonRuntime.has(f.filename)),
  )
  .reduce((t, f) => t + f.additions + f.deletions, 0);
const generatedLines = files
  .filter((f) => isGenerated(f.filename))
  .reduce((t, f) => t + f.additions + f.deletions, 0);
console.log(
  `PR #${pr} · ${repo} · ${changed} files, ${lines} lines` +
    (proseLines + generatedLines > 0
      ? ` (${lines - proseLines - generatedLines} runtime, ${proseLines} prose` +
        (generatedLines > 0 ? `, ${generatedLines} generated` : '') +
        ')'
      : '') +
    `, ${rounds.length} rounds`,
);
console.log(
  `product tree: ${
    productIsTooling
      ? "scripts/ IS this PR's product"
      : productIsProse
        ? "prose IS this PR's product — soft means ONE round, not low value"
        : 'src/ (tooling findings are soft)'
  }`,
);
console.log('');

// The previous round's findings, in words. Copilot delivers one finding per
// round when the findings are one class, and three rounds on three different
// files can share a single cause — which the path-keyed three-round rule cannot
// see. Printed so the operator reads the pattern instead of re-opening bodies.
const prev = scored.at(-2);
if (prev?.texts?.length && last?.texts?.length) {
  console.log('previous round said:');
  for (const t of prev.texts.slice(0, 3)) console.log(`  - ${t}`);
  console.log('this round says:');
  for (const t of last.texts.slice(0, 3)) console.log(`  - ${t}`);
  console.log(
    '  (same cause twice? §5: sweep the CLASS before pushing, not the instance)',
  );
  console.log('');
}

if (diminishing) {
  say(
    true,
    'diminishing      ',
    `rounds ${recent.map((r) => r.n).join(', ')} produced ${recentFindings} finding(s) between them — §8's diminishing-returns clause applies, bar is ONE round`,
  );
}
if (docSynced.size > 0) {
  say(
    true,
    'doc-sync         ',
    `${[...docSynced.keys()].join(', ')} — findings there do not reset the counter §5 in the round each ## Doc-sync entry names (or the first round that flagged it); later findings count`,
  );
}
if (humanReviewer) {
  if (destructive) {
    say(
      false,
      'human review     ',
      `"${humanReviewer}" claimed, but this diff touches a destructive path (${destructivePaths.slice(0, 3).join(', ')}) — §8 gives those clean-after-clean and nothing relaxes it`,
    );
  } else {
    say(
      true,
      'human review     ',
      `reviewed by "${humanReviewer}" per the PR body — bar is ONE clean round, not two §8. Unresolved Crit/High/Med still block`,
    );
  }
} else if (destructive) {
  say(
    true,
    'destructive path ',
    copilotOff.declared
      ? `${destructivePaths.slice(0, 3).join(', ')} — \`## Copilot off\`: the two Claude passes are this diff's review, so read them with §8's care`
      : `${destructivePaths.slice(0, 3).join(', ')} — §8 wants clean AFTER clean here`,
  );
}

if (unpushed) {
  say(
    false,
    'push landed',
    `local ${localHead.slice(0, 7)} is not ${remoteHead ? `origin/${prData.head.ref}` : 'the PR head'} ${pushTarget.slice(0, 7)} — your last push did NOT happen. Push before counting any round §1`,
  );
} else if (onHeadBranch) {
  say(
    true,
    'push landed',
    `local HEAD matches ${remoteHead ? `origin/${prData.head.ref}` : 'the PR head'}`,
  );
}

if (stale) {
  // A warning, not a block: it forbids TRIAGING that review, not merging. The
  // usual way to be here is having just pushed a fix, which is progress.
  warn(
    'stale review     ',
    `the last review saw ${last.sha.slice(0, 7)}, head is ${head.slice(0, 7)} — do not triage it §3`,
  );
} else {
  say(true, 'stale review     ', 'the last review saw the current head');
}

say(
  true,
  'rounds           ',
  rounds
    .map(
      (r) =>
        `${r.n}:${r.errored ? 'err' : r.staleAtSubmit ? 'stale' : r.count === 0 ? 'clean' : `${findingsIn(r)}${roundWeight(r) === 'soft' ? 's' : ''}`}`,
    )
    .join(' '),
);

// Copy strings are product-tree by path and cannot break a contract the way a
// branch can — and `check:copy-drift` already covers the drift case in CI. A
// round landing only on them earns the same single verification round §9 grants
// a doc-only PR: two rounds is ~25 minutes to confirm a sentence.
const isCopy = (p) => p.startsWith('src/lib/copy/');
const lastScored = scored.at(-1);
const copyOnlyRound = copyOnly(scored, cleanStreak, isCopy, isDeclined);
const humanReviewApplies = Boolean(humanReviewer) && !destructive;

// A destructive path never takes a lowered bar: clean-after-clean, whatever else applies (§8).
// A doc-only PR takes no Copilot round at all (§9, owner ruling 2026-10-30): it merges on green CI.
const needed = destructive
  ? 2
  : docOnly
    ? 0
    : copyOnlyRound || humanReviewApplies || diminishing
      ? 1
      : 2;
// OWNER RULING 2026-10-30: ONE Copilot round per code PR. Copilot review is billed per review to
// the org's AI credits, and Hugh judged confirmation rounds not worth their cost. A code PR meets the
// bar once it has one scored round (any result): the agent fixes every valid finding and merges on
// green CI. A doc-only PR takes none (§9). `needed` and the clean streak are still printed for
// context, but they no longer decide the bar.
// OWNER RULING 2026-11-08: on a risky PR that declares `## Copilot off`, the door alone decides
// (copilotOffBar): /code-review plus the checklist pass. Destructive diffs included, as with the
// budget stop: with no Copilot there are no rounds to stand clean after clean, so the two Claude
// passes are their review. Without the heading, one Copilot round still meets the bar, a path kept
// only for the ruling's rollback trigger.
const offBar = copilotOffBar(copilotOff, risky);
const barMet =
  (docOnly && !destructive) || noReview
    ? true
    : offBar !== null
      ? offBar
      : budgetStop && (!risky || claudeReviewed)
        ? true
        : risky
          ? scored.length >= 1
          : claudeReviewed || scored.length >= 1;
say(
  true,
  'copilot scope     ',
  risky
    ? `RISKY: ${riskyPaths.slice(0, 4).join(', ') || 'destructive diff'}; ${
        copilotOff.declared
          ? `Copilot off: /code-review ${claudeReviewed && copilotOff.codeReview ? 'recorded' : 'needed'}, checklist pass ${claudeReviewed && copilotOff.checklist ? 'recorded' : 'needed'}`
          : 'write `## Copilot off` and record /code-review plus the checklist pass (owner ruling 2026-11-08)'
      }`
    : docOnly || noReview
      ? 'doc/test/script/copy-only: no review'
      : `not risky${override.applied ? ` (declared under ${NOT_RISKY_TITLE})` : ''}: Claude review${claudeReviewed ? ' recorded' : claudePlaceholder ? ' heading is a placeholder, not a record' : ' needed'}, no Copilot`,
);
// One line per declaration, applied or ignored, so the month-end report can count them.
const clip = (t) => (t.length > 140 ? `${t.slice(0, 137)}...` : t);
if (override.applied)
  say(
    true,
    'risk override     ',
    `${NOT_RISKY_TITLE} APPLIED over ${riskyPaths.slice(0, 3).join(', ')}: "${clip(override.reason)}"`,
  );
else if (override.declared)
  say(
    true,
    'risk override     ',
    `${NOT_RISKY_TITLE} IGNORED: ${override.ignored}${override.reason ? ` (reason given: "${clip(override.reason)}")` : ''}`,
  );
// Printed on every PR that declares it, like the budget stop, so the month report can count it.
if (copilotOff.declared)
  say(
    !risky || copilotOff.opens,
    'copilot off      ',
    !risky
      ? '`## Copilot off` in the body: no Copilot requests (owner ruling 2026-11-08)'
      : copilotOff.opens
        ? '`## Copilot off` in the body: merging on /code-review + checklist pass, no Copilot round (owner ruling 2026-11-08)'
        : `\`## Copilot off\` in the body, but missing ${copilotOff.missing.join('; ')}`,
  );
if (budgetStop && !(copilotOff.declared && risky))
  say(
    false,
    'budget stop      ',
    '`## Copilot budget stop` in the body: merging with no Copilot round (owner ruling 2026-10-30)',
  );
// §7's hard stop, computed here rather than only reported below, because it is
// a third door out of the merge bar and not merely a warning.
//
// §7 says twelve rounds or four hours is a hard stop on REQUESTING: fix what is
// Crit/High/Med in the product tree, merge, and report the rest. §8 says two
// clean rounds. Left as separate rules those two deadlock — no new round may be
// asked for, so no clean round can ever arrive, and the gate printed both its
// own "merge and report" and its own refusal to allow it. That is what happened
// on one PR: twelve rounds, green CI, nothing above Low outstanding, and
// the only way out was a hand merge around the hook.
//
// Copilot cannot resolve its own threads, which is what makes the deadlock
// reachable rather than theoretical: a finding fixed in round 2 is re-posted
// verbatim every round after, and a round is dirty by path even when the review
// itself says "0 new comments". One PR had four such rounds.
// The 4-hour clock bounds a review LOOP, so a PR with no rounds cannot have
// exhausted one. A PR held unreviewed on purpose — waiting for a feature line to
// land, waiting on a decision — was blocked from EVER requesting its first
// review once it had been open four hours, which is the opposite of the rule's
// intent and unrecoverable: the only move that clears it is the one it forbids.
// Counted on SCORED rounds: an errored or stale review is not a round (§4), so a run of Copilot
// errors must not bring the hard stop forward.
const hardStop = scored.length >= 12 || (openedHours >= 4 && scored.length > 0);
// ---- oscillation -----------------------------------------------------------
// The three-round rule says a surface drawing findings three rounds running is a
// SCOPE decision. It warned, and a warning is not enough: on one PR one line
// drew findings in six consecutive rounds, rounds 5 and 6 contradicting each
// other outright, and each fix was correct and immediately superseded.
//
// At four consecutive rounds on one path the re-request is BLOCKED until the PR
// body records the decision in `## Settled`. Recording it is the escape, because
// the thing that ends an oscillation is a ruling, not another patch.
// Over SCORED rounds: a stale or errored review is discarded unread (§3, §4), so it cannot move a
// file toward the four-round block.
const consecutive = (path) => {
  let n = 0;
  for (const r of [...scored].reverse()) {
    if (r.paths.includes(path)) n += 1;
    else break;
  }
  return n;
};
// ONLY ON A FILE THE PR DID NOT CREATE. On a PR that introduces one component,
// that file is the only place a finding CAN land, so repeat findings there are
// the loop working rather than a surface arguing with itself — and blocking the
// fix would strand the PR. The oscillation this catches is on code that already
// existed and whose meaning the review keeps relitigating.
const added = new Set(
  files.filter((f) => f.status === 'added').map((f) => f.filename),
);
const oscillating = [...new Set(scored.flatMap((r) => r.paths))]
  // Any mention releases it, whatever round: this escape records a RULING, and
  // discounts no finding.
  .filter((p) => consecutive(p) >= 4 && !mentions(settled, p) && !added.has(p));

// §5 asks whether the FIX changed production code, not where Copilot anchored the finding
// (fix-scope.mjs). Once the author has pushed past the last round, it is weighed by the files
// changed between the commit it reviewed and the head; when that cannot be read, by its anchors.
let lastFixPaths = null;
if (last && stale && last.count > 0) {
  try {
    lastFixPaths = fixPaths(
      JSON.parse(run(['api', `repos/${repo}/compare/${last.sha}...${head}`])),
    );
  } catch {
    // No comparison (a fork's head, a sha gone after a force push): the anchors decide.
  }
}
// A test helper or fixture directory is not product code, though classify reads it so.
const fixIsProduct = (p) =>
  classify(p) === 'product' && (productIsTooling || !isTestOrScript(p));
const lastFixWeight =
  last && stale && last.count > 0
    ? fixWeight({
        anchorWeight: roundWeight(last),
        open: last.paths.filter((p) => !isAnswered(p, last.n) && !isHandoff(p))
          .length,
        describing: !last.pressing && last.inlineCount === 0,
        paths: lastFixPaths,
        isProduct: fixIsProduct,
      })
    : null;

// §5's other door: a round whose fix touched no production code earns no new round, so
// fixing it and pushing IS the way out. Without this the two rules deadlock —
// no re-request allowed, and no clean round can ever arrive.
const softFixed = Boolean(
  last && last.count > 0 && lastFixWeight === 'soft' && stale && !destructive,
);
const softFixedWhy =
  lastFixPaths && !lastFixPaths.some(fixIsProduct)
    ? 'the fix since it changed no production code'
    : 'its findings were soft';
// §7's hard stop releases the merge bar, except on a destructive path: there requesting stops,
// but the merge waits for the user rather than shipping a delete on an unconfirmed round.
const hardStopReleases = hardStop && !destructive;
say(
  barMet || (!doorShut && (softFixed || hardStopReleases)),
  'merge bar        ',
  doorShut
    ? `\`## Copilot off\` declared on a risky PR: missing ${copilotOff.missing.join('; ')} (owner ruling 2026-11-08)`
    : barMet
      ? (docOnly && !destructive) || noReview
        ? 'doc, test, script or copy-only: no review round needed (owner ruling 2026-10-30)'
        : copilotOff.declared && risky && copilotOff.opens
          ? 'risky PR, Copilot off: /code-review and checklist pass recorded (owner ruling 2026-11-08)'
          : budgetStop
            ? 'Copilot budget stop recorded: merging on green CI'
            : risky
              ? `risky PR: ${scored.length} Copilot round(s), one required (owner ruling 2026-10-30)`
              : claudeReviewed
                ? 'not risky: Claude review recorded (owner ruling 2026-10-30)'
                : `not risky: ${scored.length} Copilot round(s) already ran, which also meets the bar`
      : softFixed
        ? `round ${last.n} earns no new round (${softFixedWhy}) — §5 says merge without another round`
        : hardStop && destructive
          ? `${cleanStreak} trailing, need ${needed} — §7's hard stop ends requesting, but this diff is destructive, so the merge waits for the user to confirm it §8`
          : hardStop
            ? `${cleanStreak} trailing, need ${needed} — but §7's hard stop releases it: merge and report what is left`
            : `${cleanStreak} successful round(s) trailing, need ${needed} §8`,
);

if (lastFixWeight && lastFixPaths && lastFixWeight !== roundWeight(last)) {
  say(
    true,
    'fix scope        ',
    lastFixWeight === 'soft'
      ? `round ${last.n} was anchored on the product tree, but the fix since it touched only ${lastFixPaths.slice(0, 3).join(', ')} — no production change, so no new round §5`
      : `round ${last.n} was anchored off the product tree, but the fix since it changed production code (${lastFixPaths
          .filter(fixIsProduct)
          .slice(0, 3)
          .join(', ')}) §5`,
  );
}

if (repeated.length) {
  warn(
    'three-round rule ',
    `${repeated.join(', ')} drew findings in rounds ${lastThree.map((r) => r.n).join(', ')} — make a SCOPE decision, not another fix §7`,
  );
} else {
  say(
    true,
    'three-round rule ',
    'no path has drawn findings three rounds running',
  );
}

if (settled.size) {
  const scope = (r) =>
    r === null
      ? 'first round that flagged it'
      : `round ${[...r].sort((a, b) => a - b).join(', ')}`;
  say(
    true,
    'declined         ',
    `${[...settled].map(([p, r]) => `${p} (${scope(r)})`).join(', ')} discounted from those rounds' weight only — from the PR body's ## Settled §6`,
  );
}

if (scored.length > 3 && lastThreeOnNew) {
  warn(
    'new surface      ',
    `the last three rounds all landed on code this PR created — ask whether the fix that added it was in scope §7`,
  );
}

if (scored.length > 3 && addedLate.length) {
  warn(
    'late new files   ',
    `${addedLate.join(', ')} added after round 3 — that is new review surface §7`,
  );
}

if (hardStop) {
  warn(
    'hard stop        ',
    destructive && !barMet
      ? `round ${scored.length}, open ${openedHours.toFixed(1)}h — stop requesting; this diff is destructive and its bar is unmet, so ask the user to confirm the merge §7 §8`
      : `round ${scored.length}, open ${openedHours.toFixed(1)}h — stop requesting, merge and report §7`,
  );
}

if (prData.base.ref !== prData.base.repo.default_branch) {
  warn(
    'stacked PR       ',
    `based on ${prData.base.ref}, not ${prData.base.repo.default_branch} §10`,
  );
}
// Counted on the RUNTIME diff. A threshold that fires on a 2,400-line copy
// module is measuring the wrong thing: that module cannot be split without
// splitting the page it draws, and prose reads far faster than a branch.
const runtimeLines = lines - proseLines - generatedLines;
// The pre-open trial (§10b) only answers its question if every PR feeds it. The
// gate cannot run the pass — that is a subagent the session dispatches — but it
// can see whether this branch ever recorded one.
if (onHeadBranch) {
  const ledger = ledgerPath();
  // A filesystem path, not a URL's: `.pathname` keeps `%20` for a space in the install path.
  const here = dirname(fileURLToPath(import.meta.url));
  const quote = (p) => `'${p.replaceAll("'", `'\\''`)}'`;
  let recorded = false;
  try {
    recorded = JSON.parse(readFileSync(ledger, 'utf8')).entries.some(
      // Rows carry the repository of the checkout that recorded them, which on a fork PR is
      // the head repository, not the base this gate reads the PR from.
      (e) =>
        e.branch === localBranch &&
        // The recorder tags a row with its checkout's origin: the head repository, or the
        // base repository for a fork PR checked out there. Either is this PR's.
        (entryMatchesRepo(e, prData.head.repo?.full_name ?? repo) ||
          entryMatchesRepo(e, prData.base.repo?.full_name ?? repo)),
    );
  } catch {
    /* no ledger yet */
  }
  if (!recorded) {
    warn(
      'pre-open pass    ',
      `no cold-eyes record for ${localBranch}. §10b: before \`gh pr create\`, dispatch a general-purpose ` +
        `subagent with ${join(here, 'precheck-prompt.md')}, then ` +
        `\`node ${quote(join(here, 'precheck.mjs'))} record <file|->\`. ` +
        `Run it on EVERY PR while the trial is open, not the uncertain ones (it needs the subagent grant a project gives in AGENTS.md or .claude/fwd/pr-review.md; without one, ask once)`,
    );
  } else {
    say(true, 'pre-open pass    ', 'recorded §10b');
  }
}

if (changed > 20 || runtimeLines > 800) {
  warn(
    'size gate        ',
    `${changed} files / ${runtimeLines} runtime lines — over the split threshold §10` +
      (proseLines + generatedLines > 0
        ? ` (${proseLines} prose and ${generatedLines} generated lines excluded)`
        : ''),
  );
} else if (lines > 800) {
  say(
    true,
    'size gate        ',
    `${runtimeLines} runtime lines of ${lines} — prose is not split surface §10`,
  );
}

// ---- CI on the head ---------------------------------------------------------
// The review bar says nothing about whether the build passes. One PR merged
// with its CI run red: the merge was chained after a `gh pr checks` wait that
// returned on completion, not on success, and nothing here looked at checks.
// A PENDING check blocks too, because a chained wait-then-merge reaches this
// hook before the wait has run, and "not finished" is not "passed".
// Read only when judging a merge: it is two more API calls nothing else needs.
const ciProblems = [];
if (action === 'merge') {
  const sha = prData.head.sha;
  const runs = gh(`repos/${repo}/commits/${sha}/check-runs`).flatMap(
    (p) => p.check_runs ?? [],
  );
  const statuses = gh(`repos/${repo}/commits/${sha}/statuses`);
  const workflowRuns = gh(`repos/${repo}/actions/runs?head_sha=${sha}`).flatMap(
    (p) => p.workflow_runs ?? [],
  );
  const ci = ciProblemsOf({ runs, statuses, workflowRuns });
  ciProblems.push(...ci.problems);
  say(
    ciProblems.length === 0,
    'CI on head       ',
    ciProblems.length
      ? ciProblems.join('; ')
      : `${ci.count} check(s) green on ${sha.slice(0, 7)}`,
  );
}

// ---- the action -------------------------------------------------------------
if (action === 'merge') {
  console.log('');
  if (ciProblems.length > 0) {
    blocks.push(
      `CI is not green on the head: ${ciProblems.join('; ')}. Wait for it, or re-run a flaky job, ` +
        'then merge in a SEPARATE command — a chained wait-then-merge is judged before the wait runs.',
    );
  }
  if (oscillating.length > 0) {
    blocks.push(
      `${oscillating.join(', ')} drew findings in ${consecutive(oscillating[0])} consecutive rounds. ` +
        "§7: that is a scope decision, not another fix. Record the ruling in the PR body's " +
        '`## Settled` (naming the file) and merge, or change what the code is — do not patch it again.',
    );
  }
  if (unpushed) {
    blocks.push(
      'your local branch is ahead of the PR head — you would be merging without your last commits.',
    );
  }
  // With `## Copilot off` declared, the door is the only exit, so its block comes first.
  if (hardStop && destructive && !barMet && !doorShut) {
    blocks.push(
      'hard stop on a destructive path: requesting has ended, but this diff deletes or overwrites ' +
        'user data, so the merge waits for the user to confirm it (§8).',
    );
  } else if (!barMet) {
    blocks.push(
      (doorShut
        ? `bar not met: \`## Copilot off\` is declared on this risky PR (${riskyPaths.slice(0, 3).join(', ') || 'destructive diff'}), ` +
          `but it is missing ${copilotOff.missing.join('; ')}. Run what is missing; ` +
          COPILOT_OFF_HINT +
          ' (owner ruling 2026-11-08).'
        : risky
          ? `bar not met: risky code PR (${riskyPaths.slice(0, 3).join(', ') || 'destructive diff'}) takes ` +
            '/code-review medium, then the risk checklist pass, with no Copilot (owner ruling 2026-11-08): ' +
            'write `## Copilot off` in the PR body, and ' +
            COPILOT_OFF_HINT +
            '.'
          : claudePlaceholder
            ? 'bar not met: the `## Claude review` section is empty or a placeholder (pending, TBD, n/a), ' +
              'which is not a record. Run the review, then ' +
              RECORD_HINT +
              '.'
            : `bar not met: ${override.applied ? `declared not risky under ${NOT_RISKY_TITLE}` : 'not a risky PR'}, so no Copilot. Run a Claude review (the caveman:cavecrew-reviewer ` +
              'agent on the diff), fix what it finds, record it under `## Claude review` in the PR body (' +
              RECORD_HINT +
              '), then merge on green CI.') +
        (doorShut
          ? ''
          : ` Clean streak ${cleanStreak}. Last SCORED round ` +
            `(${lastScored ? `#${lastScored.n}` : 'none'}) landed on ` +
            `${lastScored?.paths.join(', ') || 'no findings'}.`) +
        (last?.errored
          ? ' The newest review errored and was dropped — that is an outage, not a round.'
          : ''),
    );
  }
  if (blocks.length === 0) console.log('MERGE ALLOWED');
}

if (action === 'rerequest') {
  console.log('');
  if (copilotOff.declared) {
    blocks.push(
      '`## Copilot off` is in the PR body: no Copilot request on this PR (owner ruling 2026-11-08). ' +
        (risky
          ? 'Run /code-review medium and the risk checklist pass, record both under `## Claude review` ' +
            `(${COPILOT_OFF_HINT}), and merge on green CI.`
          : docOnly || noReview
            ? 'This PR takes no review: read your own diff and merge on green CI.'
            : 'Run the Claude review (the caveman:cavecrew-reviewer agent on the diff), record it under ' +
              '`## Claude review`, and merge on green CI.'),
    );
  }
  if (!risky && !(docOnly && !destructive) && !noReview) {
    blocks.push(
      (override.applied
        ? `declared not risky under \`${NOT_RISKY_TITLE}\`, so no Copilot `
        : 'not a risky PR (no DB, migration, auth, payments, API-route or security path), so no Copilot ') +
        '(owner ruling 2026-10-30). Run a Claude review, record it under `## Claude review`, merge on green CI.',
    );
  }
  if (risky && scored.length >= 1) {
    blocks.push(
      'one Copilot round per code PR (owner ruling 2026-10-30): this PR has had its round. Fix every valid ' +
        'finding and merge on green CI; do not request another.',
    );
  }
  if ((docOnly && !destructive) || noReview) {
    blocks.push(
      'doc-only PR (design, docs, plans, briefs, READMEs): never request Copilot on it (§9, owner ruling ' +
        '2026-10-30). Fix what you find yourself and merge on green CI.',
    );
  }
  if (unpushed) {
    blocks.push(
      'your local branch is ahead of the PR head — the push did not land, so a review now ' +
        'would read stale code. Push, confirm `pulls/N --jq .head.sha` matches your HEAD, then re-request.',
    );
  }
  // With `## Copilot off` declared, the block above already names the exit; §7's text would not.
  if (hardStop && !copilotOff.declared) {
    blocks.push(
      `round ${scored.length}, open ${openedHours.toFixed(1)}h — §7's hard stop. There is no round ${scored.length + 1}: fix what is Crit/High/Med in the product tree, ` +
        (destructive && !barMet
          ? 'then ask the user to confirm the merge: this diff is destructive and its bar is unmet (§8).'
          : 'merge, and report the rest.'),
    );
  }
  if (barMet) {
    blocks.push(
      `the bar is already met — §8 says merge. An outstanding nit rides in the merge commit or becomes a follow-up; it never becomes another round.`,
    );
  }
  // §5's block, EXCEPT when the bar is the reason a round is needed.
  //
  // THE DEADLOCK THIS CLOSES. §6's `## Settled` discount does two things at
  // once: it marks a round successful (counting toward §8's bar) and strips the
  // weight §5 reads to decide whether a re-request is earned. So a round whose
  // only finding was declined is at once "clean enough to count" and "too
  // trivial to earn another round" — and when that lands with the trailing
  // count one short of the bar, no move the gate permits can advance the PR.
  // Three agents stopped overnight on exactly this, and the clearest symptom is
  // that §5's own text recommends merging while the merge action refuses it.
  //
  // §5 exists to stop re-requests that CHASE NITS. A re-request whose purpose is
  // to satisfy §8 is not that, and the gate already knows the trailing count —
  // so when the merge is blocked for want of a clean round, the request is the
  // legal move rather than the forbidden one.
  const mergeBlocked =
    !barMet && !softFixed && !hardStopReleases && oscillating.length === 0;
  // §7: four consecutive rounds on one existing surface is a scope decision, and another round is
  // the one move that cannot make it. Record the ruling in `## Settled` to release this.
  if (oscillating.length > 0) {
    blocks.push(
      `${oscillating.join(', ')} drew findings in ${consecutive(oscillating[0])} consecutive rounds. ` +
        "§7: make the scope decision and record it in the PR body's `## Settled` (naming the file); " +
        'another round will not settle it.',
    );
  }
  if (softFixed && !barMet) {
    blocks.push(
      `round ${last.n} earns no new round (${softFixedWhy}), so §5 says merge WITHOUT a new round.`,
    );
  }
  if (
    last &&
    !stale &&
    roundWeight(last) === 'soft' &&
    last.count > 0 &&
    !mergeBlocked
  ) {
    blocks.push(
      `round ${last.n} landed only on ${last.paths.join(', ')} — no Crit/High/Med in the product tree, so §5 says fix, push, merge WITHOUT a new round.`,
    );
  }
  if (blocks.length === 0) {
    console.log('RE-REQUEST ALLOWED');
    if (
      mergeBlocked &&
      last &&
      roundWeight(last) === 'soft' &&
      last.count > 0
    ) {
      console.log(
        "  (§5 would normally forbid this; it is allowed because §8's bar is " +
          `${cleanStreak}/${needed} and a re-request is the only move that can close it.)`,
      );
    }
  }
}

if (blocks.length) {
  console.log('');
  // A last guard against the class of bug this script exists to prevent: if the
  // operator is told no on BOTH doors, that is the gate contradicting itself,
  // not a rule. Name it, and name the way out, rather than leaving them to find
  // it by trying both.
  if (action) {
    const otherAllowed =
      oscillating.length === 0 &&
      (action === 'merge'
        ? !hardStop && !barMet
        : barMet || softFixed || hardStopReleases);
    // With `## Copilot off` declared, a re-request is never the other door. When the bar is met, what
    // blocks is CI or an unpushed commit, and each of those blocks names its own exit, so no NOTE.
    if (copilotOff.declared) {
      if (!barMet) {
        console.log(
          'NOTE: `## Copilot off` refuses every Copilot request, so the only exit is the merge: record ' +
            (copilotOff.missing.length && risky
              ? `what is missing (${copilotOff.missing.join('; ')})`
              : 'the review this PR takes under `## Claude review`') +
            (oscillating.length > 0
              ? ", and record §7's scope ruling in the PR body's `## Settled` (naming the file)"
              : '') +
            ', then merge on green CI.',
        );
        console.log('');
      }
    } else if (!otherAllowed && hardStop && destructive && !barMet) {
      console.log(
        "NOTE: both actions are blocked on purpose. §7's hard stop has ended requesting, and this " +
          'diff is destructive, so its bar is not lowered. The exit is the user confirming the merge.',
      );
      console.log('');
    } else if (!otherAllowed && oscillating.length > 0) {
      console.log(
        "NOTE: both actions are blocked by §7's four-round rule. The exit is a scope ruling in the " +
          "PR body's `## Settled` naming the file, not another round.",
      );
      console.log('');
    } else if (!otherAllowed) {
      console.log(
        'NOTE: the other action is blocked too. That is a gate contradiction, not a rule — ' +
          "§8's diminishing-returns clause is the intended exit: merge on one clean round " +
          'after substantive prior rounds, and report what is outstanding.',
      );
      console.log('');
    }
  }
  console.log(`BLOCKED by pr-review:`);
  for (const b of blocks) console.log(`  - ${b}`);
  process.exit(1);
}
