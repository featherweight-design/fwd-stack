#!/usr/bin/env node
// Ledger for the pre-open review pass. The pass itself is a subagent the session
// dispatches; this records what it said and, after the Claude review, what that predicted.
//
// It exists because nobody knows the overlap number yet. Three PRs of data
// decide whether the pass stays or gets deleted — and a
// number nobody wrote down is a number nobody has.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// Bump when anything changes what the scoring review returns: a reviewer model change or a prompt
// edit. Rows carry the era they were scored under, and the report never mixes them. The labels
// are opaque: ledger rows store them, so they are never renamed.
const CURRENT_ERA = 'pre-720';

import { ensureLedgerDir, ledgerPath } from './ledger-path.mjs';
import { entryMatchesRepo, repoFromRemoteUrl } from './git-remote.mjs';

const LEDGER = ledgerPath();
const read = () =>
  existsSync(LEDGER)
    ? JSON.parse(readFileSync(LEDGER, 'utf8'))
    : { entries: [] };
const write = (d) => (
  ensureLedgerDir(LEDGER),
  writeFileSync(LEDGER, `${JSON.stringify(d, null, 2)}\n`)
);
const die = (m) => {
  console.error(m);
  process.exit(1);
};

const [cmd, ...argv] = process.argv.slice(2);
// `--repo=` is read below and never taken as a positional argument by any command.
const rest = argv.filter((a) => !a.startsWith('--repo='));

// The repository this checkout belongs to, or `--repo=o/r` when scoring from elsewhere. Rows
// carry it so two repositories' branch names and PR numbers never share a row.
const repoFlag = argv.find((a) => a.startsWith('--repo='))?.slice(7);
const currentRepo = () => {
  if (repoFlag) return repoFlag;
  try {
    return repoFromRemoteUrl(
      execFileSync('git', ['remote', 'get-url', 'origin'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    return null;
  }
};

// ---- record: what the pass said, before the PR exists ------------------------
if (cmd === 'record') {
  // A bare `record` used to read stdin. An agent's shell keeps stdin open and
  // never writes to it, so a bare call blocked forever: two lanes hung on it for
  // 37 and 77 minutes on 2026-10-17. Stdin is now read only when asked for with
  // `-`, and a bare call fails fast with the forms that work.
  const [file] = rest;
  if (!file) {
    console.error(
      'precheck record: name the findings. Use one of:\n' +
        '  precheck.mjs record <file>          (one finding per line, or NO FINDINGS)\n' +
        "  printf 'NO FINDINGS\\n' | precheck.mjs record -\n" +
        '  precheck.mjs record - < findings.txt',
    );
    process.exit(2);
  }
  const body = (
    file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8')
  ).trim();
  const findings =
    body === 'NO FINDINGS' || body === ''
      ? []
      : body
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && !l.startsWith('#'));
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const repo = currentRepo();
  const d = read();
  d.entries = d.entries.filter(
    (e) => e.branch !== branch || e.scored || !entryMatchesRepo(e, repo),
  );
  d.entries.push({
    ...(repo ? { repo } : {}),
    branch,
    head,
    at: new Date().toISOString(),
    findings,
    scored: false,
  });
  write(d);
  console.log(`recorded ${findings.length} pre-open finding(s) on ${branch}`);
  process.exit(0);
}

// ---- unrun: a PR deliberately not passed, with its reason ------------------
// Absence is ambiguous — it reads the same as a PR nobody bothered with. An
// explicit row keeps the trial honest in the direction that does not flatter it,
// and a run of them is visible in `status` rather than invisible.
if (cmd === 'unrun') {
  const [prNum, ...why] = rest;
  if (!prNum || why.length === 0)
    die('usage: precheck.mjs unrun <pr> <reason…>');
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const repo = currentRepo();
  const d = read();
  d.entries.push({
    ...(repo ? { repo } : {}),
    branch,
    pr: Number(prNum),
    at: new Date().toISOString(),
    unrun: true,
    reason: why.join(' '),
  });
  write(d);
  console.log(`#${prNum} recorded as UNRUN — ${why.join(' ')}`);
  process.exit(0);
}

// ---- score: what the Claude review returned, and how much of it the pass had -----------
// Overlap is judged by the session, not matched by string: the two reviewers
// describe the same defect in different words, and a matcher that tried would
// report a low overlap over a pass that had predicted everything.
if (cmd === 'score') {
  const args = rest.filter(
    (a) =>
      !a.startsWith('--kind=') &&
      !a.startsWith('--fixed=') &&
      !a.startsWith('--shipped=') &&
      !a.startsWith('--era='),
  );
  const kind = rest
    .find((a) => a.startsWith('--kind='))
    ?.slice('--kind='.length);
  const fixedArg = rest
    .find((a) => a.startsWith('--fixed='))
    ?.slice('--fixed='.length);
  const eraArg = rest
    .find((a) => a.startsWith('--era='))
    ?.slice('--era='.length);
  const shippedArg = rest
    .find((a) => a.startsWith('--shipped='))
    ?.slice('--shipped='.length);
  const [pr, predicted, total, ...note] = args;
  const KINDS = ['arithmetic', 'layout', 'modelling', 'wiring', 'prose'];
  if (kind !== undefined && !KINDS.includes(kind)) {
    die(`--kind must be one of: ${KINDS.join(' | ')} (got "${kind}")`);
  }
  if (
    !pr ||
    predicted === undefined ||
    total === undefined ||
    kind === undefined
  ) {
    die(
      'usage: precheck.mjs score <pr> <predicted> <review-crit-high-med-total> --kind=K [--fixed=N --shipped=M] [note…]\n' +
        "  --fixed=N: how many of the pass's findings you FIXED before opening. This is the\n" +
        "  pass's actual output — a defect fixed pre-open never reaches the review, so the\n" +
        '  predicted/review ratio scores it ZERO exactly when the pass worked best.\n' +
        '  --shipped=M: of those N, how many would have SHIPPED — past your own tests,\n' +
        '  probes and checks — rather than merely costing a fix after review. This number does\n' +
        '  not decay as the loop gets faster, and is the half a time-saved argument misses.\n' +
        '  --era=E: which reviewer produced the review. Defaults to the current era; pass it\n' +
        '  only to correct a row. Rows are comparable WITHIN an era, never across one.\n' +
        "  --kind: what the PR's risk WAS — arithmetic | layout | modelling | wiring | prose.\n" +
        '  The five classes the pass targets are not equally reachable across these, so a\n' +
        '  number averaged over one category is a fact about the sample, not the pass.',
    );
  }
  if (!/^[1-9][0-9]*$/.test(pr))
    die(`score: <pr> must be a PR number (got "${pr}")`);
  const d = read();
  // `predicted` counts the review's findings the pass had already caught, so it cannot
  // exceed the review's own total. A row recording 2 of 1 means the scorer counted
  // pass findings that were never in the review — which is the pre-open fix count
  // (`--fixed`), a different quantity with no denominator.
  if (Number(predicted) > Number(total)) {
    die(
      `predicted ${predicted} exceeds review total ${total}. ` +
        "`predicted` is how many of the REVIEW's findings the pass had already caught. " +
        'Findings the pass raised that the review never did are `--fixed=N`, counted separately.',
    );
  }
  // The PR's head branch comes from GitHub, never from the working directory: `score` runs
  // long after the branch merged, from whatever worktree or checkout is to hand, and a
  // cwd branch once attributed another lane's record to the wrong PR.
  const repo = currentRepo();
  let headBranch;
  try {
    headBranch = execFileSync(
      'gh',
      [
        'pr',
        'view',
        pr,
        '--json',
        'headRefName',
        '-q',
        '.headRefName',
        ...(repo ? ['-R', repo] : []),
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    die(
      `score: could not read PR #${pr}'s head branch from GitHub (gh pr view failed).`,
    );
  }
  if (!headBranch) die(`score: PR #${pr} has no head branch on GitHub.`);
  // Match only a record for this PR number or for this PR's head branch.
  const byPr = [...d.entries]
    .reverse()
    .find((e) => e.pr === Number(pr) && !e.unrun && entryMatchesRepo(e, repo));
  const entry =
    byPr ??
    [...d.entries]
      .reverse()
      .find(
        (e) =>
          e.branch === headBranch &&
          !e.scored &&
          !e.unrun &&
          entryMatchesRepo(e, repo),
      );
  if (!entry) {
    die(
      `no pre-open record for #${pr} or for its head branch ${headBranch}. ` +
        'Run `record` on the PR branch before opening the PR; `score` finds it by PR ' +
        'number or head branch afterwards, from any directory.',
    );
  }
  if (entry.branch !== headBranch) {
    die(
      `refusing: the only record for #${pr} is on branch ${entry.branch}, but the PR's head is ${headBranch}.`,
    );
  }
  if (entry.scored)
    console.log(
      `re-scoring #${pr} (was ${entry.predicted} of ${entry.round1})`,
    );
  Object.assign(entry, {
    scored: true,
    pr: Number(pr),
    predicted: Number(predicted),
    // field name kept: stored ledger rows use it
    round1: Number(total),
    kind: kind || 'unstated',
    fixed: fixedArg === undefined ? null : Number(fixedArg),
    shipped: shippedArg === undefined ? null : Number(shippedArg),
    era: eraArg || CURRENT_ERA,
    note: note.join(' ') || undefined,
  });
  write(d);
  console.log(`PR #${pr}: predicted ${predicted} of ${total}`);
  report(d);
  process.exit(0);
}

// ---- reporting -------------------------------------------------------------
// Two populations, never one ratio. A row whose review raised nothing has no
// denominator: the pass could not be right or wrong about it, and summing those
// zeros into a hit rate builds a fraction whose numerator and denominator come
// from different places.
function report(d) {
  const scored = d.entries.filter((e) => e.scored);
  const eras = [...new Set(scored.map((e) => e.era || 'pre-720'))];
  if (eras.length > 1) {
    console.log('');
    console.log(
      `ERAS PRESENT: ${eras.join(', ')} — reported separately; a pooled rate across`,
    );
    console.log(
      "  eras would divide one reviewer's numerator by another's denominator.",
    );
    for (const era of eras) {
      const g = scored.filter(
        (e) => (e.era || 'pre-720') === era && e.round1 > 0,
      );
      const p = g.reduce((t, e) => t + e.predicted, 0);
      const r = g.reduce((t, e) => t + e.round1, 0);
      console.log(
        `  ${era}: ${p}/${r}${r ? ` (${Math.round((p / r) * 100)}%)` : ''} over ${g.length} scorable PR(s)`,
      );
    }
  }
  const scorable = scored.filter(
    (e) => e.round1 > 0 && (e.era || 'pre-720') === CURRENT_ERA,
  );
  const nothingToPredict = scored.filter(
    (e) => e.round1 === 0 && (e.era || 'pre-720') === CURRENT_ERA,
  );
  const p = scorable.reduce((t, e) => t + e.predicted, 0);
  const r = scorable.reduce((t, e) => t + e.round1, 0);
  const pct = r === 0 ? null : Math.round((p / r) * 100);
  const fixedKnown = scored.filter((e) => typeof e.fixed === 'number');
  const prevented = fixedKnown.reduce((t, e) => t + e.fixed, 0);
  const shipped = fixedKnown.reduce((t, e) => t + (e.shipped || 0), 0);

  console.log('');
  console.log(
    `PRE-OPEN FIXES: ${prevented} finding(s) fixed before opening, over ${fixedKnown.length} PR(s)`,
  );
  console.log(
    `  of which ${shipped} would have SHIPPED — past the author's own tests, probes and checks.`,
  );
  console.log(
    "  The pass's actual output. No denominator exists for it — a defect fixed here",
  );
  console.log(
    '  never reaches the review, which is why the hit rate below cannot see it.',
  );
  console.log(
    '  The shipped count does not decay as the loop gets faster; a fix cycle saved does.',
  );
  console.log('');
  console.log(
    `HIT RATE [era ${CURRENT_ERA}]: ${p}/${r}${pct === null ? '' : ` (${pct}%)`} of review Crit/High/Med predicted, over ${scorable.length} PR(s) that HAD findings`,
  );
  if (nothingToPredict.length > 0) {
    console.log(
      `  ${nothingToPredict.length} further PR(s) had no review findings to predict — listed, never summed:`,
    );
    for (const e of nothingToPredict)
      console.log(
        `    #${e.pr} [${e.kind || 'unstated'}] predicted ${e.predicted}, the review raised 0`,
      );
  }

  const byKind = new Map();
  for (const e of scorable) {
    const k = e.kind || 'unstated';
    const acc = byKind.get(k) || { p: 0, r: 0, n: 0 };
    byKind.set(k, {
      p: acc.p + e.predicted,
      r: acc.r + e.round1,
      n: acc.n + 1,
    });
  }
  if (byKind.size > 0) {
    console.log('');
    for (const [k, v] of byKind)
      console.log(`  ${k}: ${v.p}/${v.r} over ${v.n} PR(s)`);
    const unstated = byKind.get('unstated');
    if (unstated && unstated.n >= scorable.length / 2) {
      console.log(
        `  ${unstated.n} of ${scorable.length} scorable rows are UNSTATED — the breakdown ` +
          'cannot carry a verdict until their kinds are recovered (`score` re-scores by PR number).',
      );
    }
  }

  console.log('');
  if (scorable.length < 3) {
    console.log(
      `HOLD: ${scorable.length}/3 PRs with review findings to predict. No verdict yet.`,
    );
    return;
  }
  const unstatedN = byKind.get('unstated')?.n || 0;
  if (unstatedN >= scorable.length / 2) {
    console.log(
      `HOLD: ${unstatedN} of ${scorable.length} scorable rows have no kind. The breakdown is what ` +
        'decides whether a number is about the pass or about the sample, so no verdict prints ' +
        'until most rows carry one. `score` re-scores by PR number, from any directory.',
    );
    return;
  }
  if (byKind.size < 2) {
    console.log(
      `HOLD: every scorable PR is "${[...byKind.keys()][0]}". That is a number about the sample, ` +
        'not the pass — score a PR of another kind first.',
    );
    return;
  }
  console.log(
    pct >= 70
      ? 'VERDICT >=70%: the pass catches most of what review does. Bring this to the user.'
      : pct >= 30
        ? 'VERDICT 30-70%: the gate is paying. Keep both, unchanged.'
        : 'VERDICT <30%: the hit rate is low. Read it WITH the pre-open fix count above before ' +
          'recommending deletion — a pass that fixes everything it finds scores badly here by construction.',
  );
  if (unstatedN > 0) {
    console.log(
      `Read it with this caveat: ${unstatedN} of ${scorable.length} scorable rows have no kind, ` +
        'so the breakdown above is partial and some rows may never be claimable.',
    );
  }
  console.log('Bring the verdict to the user rather than acting on it.');
}

// ---- status -----------------------------------------------------------------
const d = read();
const scored = d.entries.filter((e) => e.scored);
const unrun = d.entries.filter((e) => e.unrun);
const open = d.entries.filter((e) => !e.scored && !e.unrun);
console.log(`pre-open trial: ${scored.length} scored PR(s)`);
for (const e of scored) {
  const f = typeof e.fixed === 'number' ? `, ${e.fixed} fixed pre-open` : '';
  console.log(
    `  #${e.pr} ${e.branch} [${e.kind || 'unstated'}]: predicted ${e.predicted} of ${e.round1}${f}${e.note ? ` — ${e.note}` : ''}`,
  );
}
for (const e of open)
  console.log(
    `  (unscored) ${e.branch}: ${e.findings.length} finding(s) recorded`,
  );
for (const e of unrun)
  console.log(`  (UNRUN) #${e.pr} ${e.branch}: ${e.reason}`);
if (unrun.length >= scored.length && unrun.length >= 2) {
  console.log(
    `WARNING: ${unrun.length} unrun vs ${scored.length} scored — the trial is not being fed.`,
  );
}
report(d);
