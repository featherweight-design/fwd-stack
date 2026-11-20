#!/usr/bin/env node
// The pr-review merge bar, computed instead of remembered.
//
// The rules were prose in a skill, read once at the start of a turn and applied from memory for
// hours afterwards. So the state is measured from GitHub and printed: every rule that can be decided
// from data is decided here rather than by recall.
//
//   node pr-gate.mjs <pr> [--action merge|rerequest] [--repo owner/name]
//
// Exit 0 when the action is allowed, 1 when a rule forbids it. `--action` with no value reports
// state without judging an action.
//
// Copilot is cut (owner ruling 2026-11-08): a Copilot review is never requested, so `rerequest` is
// always refused and no review rounds are counted. A merge needs the PR's review recorded in its
// body (a risky PR: `## Claude review` plus `## Copilot off`) and green CI on the head.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  claudeReviewState,
  riskyDoor,
  RISKY_RECORD_HINT,
  RECORD_HINT,
} from './claude-review.mjs';
import {
  NOT_RISKY_TITLE,
  riskOverride,
  riskyPathsOf,
} from './risk-override.mjs';
import {
  commentOnlyHunks,
  isCommentOnlyChange,
  isDoc,
  isDocOnlyChange,
  isGenerated,
  isHandoff,
  isVersionOnlyChange,
} from './classify.mjs';
import { ciProblemsOf } from './ci-state.mjs';
import { ledgerPath } from './ledger-path.mjs';
import {
  checkoutIsPr,
  entryMatchesRepo,
  refPath,
  repoFromRemoteUrl,
  sameRepo,
} from './git-remote.mjs';
import { parsePages } from './pages.mjs';

const args = process.argv.slice(2);
const pr = args.find((a) => /^\d+$/.test(a));
const action = args.includes('--action')
  ? args[args.indexOf('--action') + 1]
  : null;
const repoArg = args.includes('--repo')
  ? args[args.indexOf('--repo') + 1]
  : null;

// An `--action` value the gate does not know (a typo, or `--action --repo x/y` where the value was
// dropped) must not read as report-only, which exits 0: refuse it. A bare trailing `--action`
// still reports state.
if (action && !['merge', 'rerequest'].includes(action)) {
  console.log(
    `BLOCKED by pr-review:\n  - unknown --action "${action}": use merge or rerequest.`,
  );
  process.exit(1);
}

// OWNER RULING 2026-11-08: Copilot is cut. A request for a Copilot review is refused on every PR,
// before anything is read from GitHub: no PR state can make it allowed.
if (action === 'rerequest') {
  console.log(
    `BLOCKED by pr-review:\n  - Copilot is cut (owner ruling 2026-11-08): a Copilot review is never requested on any PR${pr ? `, including #${pr}` : ''}. ` +
      'What a PR takes instead: a risky code PR (DB, migrations, auth, payments, API routes, security, destructive) takes `/code-review medium` ' +
      'plus the risk checklist pass, recorded under `## Claude review` with `## Copilot off` in the PR body; ' +
      'other code takes a Claude review; doc, test, script and copy PRs take none. Fix what you find and merge on green CI.',
  );
  process.exit(1);
}

const run = (args) =>
  execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const gh = (path) => parsePages(run(['api', path, '--paginate']));

if (!pr) {
  console.error('usage: pr-gate.mjs <pr> [--action merge] [--repo owner/name]');
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
const files = gh(`repos/${repo}/pulls/${pr}/files`);

// Files whose change is shown not to touch what runs (classify.mjs): a top-level version bump in
// plugin.json or package.json, or a script edit whose every changed line is a comment. The comment
// check needs the head file's text, to see a template literal opened above a hunk; when the API
// cannot return it, the file stays runtime. These score as prose.
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

// ---- classification ---------------------------------------------------------
const isCopyPath = (p) => p.startsWith('src/lib/copy/');
const isTooling = (p) =>
  p.startsWith('scripts/') || /\.test\.\w+$/.test(p) || /probe/.test(p);

// ---- destructive paths -------------------------------------------------------
// Narrow on purpose. The first version matched Tailwind's `truncate` class and called a
// presentational tile destructive, and a false positive here silently raises the bar.
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
// discipline this repo requires, not a risk to user data.
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

// Risky means the diff is destructive (above) or touches a path where a defect costs data, money or
// access: migrations and schema, the DB layer, auth/session/proxy, payments/credits/billing, API and
// cron routes, or security code (RISKY_PATH, risk-override.mjs). A risky PR takes `/code-review
// medium` plus the checklist pass; every other code PR takes a Claude review. Both are recorded in
// the PR body under `## Claude review`.
// A path is not the rule: a display-only change to a credits file is not payments code. The PR body's
// `## Risk: not risky` section, with a real reason, clears a path-risky PR, unless the diff carries a
// hard-risky signal (risk-override.mjs, HARD_RISKY). Every declaration is printed, applied or not.
const riskyPaths = riskyPathsOf(files, nonRuntime);
const pathRisky = destructive || riskyPaths.length > 0;
const override = riskOverride(prData.body, { riskyPaths, destructive });
const risky = pathRisky && !override.applied;
// The heading alone is not a review: a section that says only "(pending)", TBD or nothing does not
// count (claude-review.mjs has the rule).
const claudeReview = claudeReviewState(prData.body);
const claudeReviewed = claudeReview.recorded;
const claudePlaceholder = claudeReview.present && !claudeReview.recorded;
// A risky PR also declares `## Copilot off` and records both passes in its Claude review.
const door = riskyDoor(prData.body);
// Test, probe, script or copy-only PRs take no review at all, like doc-only ones.
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

// The remote ref for this PR's head branch, asked once for the push-landed check below. `origin`
// answers only when it IS the PR's head repository: run with `--repo` from a checkout of another
// repo, a branch of the same name there handed back an unrelated SHA as the PR's head. Otherwise
// the API's ref for the head repo answers.
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

// ---- did the push actually happen? -----------------------------------------
// A chained `git rebase && git push && gh api …` short-circuits silently: one
// agent hit a real rebase conflict, the chain stopped, and the success line
// printed anyway. Same shape as §1's "a 200 is not proof".
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
      : ''),
);
console.log('');

if (destructive) {
  say(
    true,
    'destructive path ',
    `${destructivePaths.slice(0, 3).join(', ')} — risky: the two Claude passes are this diff's review, so read them with care`,
  );
}

if (unpushed) {
  say(
    false,
    'push landed',
    `local ${localHead.slice(0, 7)} is not ${remoteHead ? `origin/${prData.head.ref}` : 'the PR head'} ${pushTarget.slice(0, 7)} — your last push did NOT happen. Push first §1`,
  );
} else if (onHeadBranch) {
  say(
    true,
    'push landed',
    `local HEAD matches ${remoteHead ? `origin/${prData.head.ref}` : 'the PR head'}`,
  );
}

// The merge bar: the review this PR takes is recorded in its body. A risky PR takes `/code-review
// medium` plus the checklist pass under `## Claude review`, and declares `## Copilot off`. Any other
// code PR takes a Claude review. Doc, test, script and copy-only PRs take none.
const barMet =
  (docOnly && !destructive) || noReview
    ? true
    : risky
      ? door.opens
      : claudeReviewed;
say(
  true,
  'review scope     ',
  risky
    ? `RISKY: ${riskyPaths.slice(0, 4).join(', ') || 'destructive diff'}; /code-review ${claudeReviewed && door.codeReview ? 'recorded' : 'needed'}, checklist pass ${claudeReviewed && door.checklist ? 'recorded' : 'needed'}, \`## Copilot off\` ${door.declared ? 'present' : 'needed'}`
    : docOnly || noReview
      ? 'doc/test/script/copy-only: no review'
      : `not risky${override.applied ? ` (declared under ${NOT_RISKY_TITLE})` : ''}: Claude review${claudeReviewed ? ' recorded' : claudePlaceholder ? ' heading is a placeholder, not a record' : ' needed'}`,
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
say(
  barMet,
  'merge bar        ',
  barMet
    ? (docOnly && !destructive) || noReview
      ? 'doc, test, script or copy-only: no review needed'
      : risky
        ? 'risky PR: /code-review and checklist pass recorded, `## Copilot off` present'
        : 'not risky: Claude review recorded'
    : risky
      ? `risky PR: missing ${door.missing.join('; ')}`
      : claudePlaceholder
        ? 'the `## Claude review` section is a placeholder, not a record'
        : 'no `## Claude review` record',
);

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
// Read only when judging a merge: it is three more API calls nothing else needs.
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
  const ci = ciProblemsOf({
    runs,
    statuses,
    workflowRuns,
    mergeableState: prData.mergeable_state,
  });
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
  if (unpushed) {
    blocks.push(
      'your local branch is ahead of the PR head — you would be merging without your last commits.',
    );
  }
  if (!barMet) {
    blocks.push(
      risky
        ? `bar not met: risky code PR (${riskyPaths.slice(0, 3).join(', ') || 'destructive diff'}) takes ` +
            '/code-review medium, then the risk checklist pass. Missing: ' +
            `${door.missing.join('; ')}. Write \`## Copilot off\` in the PR body, and ` +
            RISKY_RECORD_HINT +
            '.'
        : claudePlaceholder
          ? 'bar not met: the `## Claude review` section is empty or a placeholder (pending, TBD, n/a), ' +
            'which is not a record. Run the review, then ' +
            RECORD_HINT +
            '.'
          : `bar not met: ${override.applied ? `declared not risky under ${NOT_RISKY_TITLE}` : 'not a risky PR'}. Run a Claude review (the caveman:cavecrew-reviewer ` +
            'agent on the diff), fix what it finds, record it under `## Claude review` in the PR body (' +
            RECORD_HINT +
            '), then merge on green CI.',
    );
  }
  if (blocks.length === 0) console.log('MERGE ALLOWED');
}

if (blocks.length) {
  console.log('');
  console.log(`BLOCKED by pr-review:`);
  for (const b of blocks) console.log(`  - ${b}`);
  process.exit(1);
}
