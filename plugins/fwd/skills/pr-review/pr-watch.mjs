#!/usr/bin/env node
// Watches one PR and prints one line per event, for the Monitor tool (each stdout line is a
// notification). Arm it ONCE, when the PR opens, and leave it running across every push:
//
//   Monitor({ command: "node <skill dir>/pr-watch.mjs <pr>", timeout_ms: 1800000,
//             description: "#<pr> CI" })
//
// It reports each head's CI once it completes, and the PR merging or closing, which ends it. It
// never exits silently: at `--minutes` (default 29, just inside Monitor's 30-minute cap) it prints that it timed
// out with the PR still open, so the lane re-arms it. Why it exists: watch-core.mjs.
//
// Under Bash `run_in_background` instead of Monitor, printed lines wake nobody: only the exit does. There, pass
// `--exit-on-ci` and it exits on the head's first terminal CI state (0 passed, 1 failed), or on the PR ending (0).
//
//   node pr-watch.mjs <pr> [--repo owner/name] [--minutes N] [--interval S] [--exit-on-ci]

import { execFileSync } from 'node:child_process';
import {
  describe,
  fitsAnotherPoll,
  primeState,
  watchStep,
} from './watch-core.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const pr = args.find((a) => /^\d+$/.test(a));
if (!pr) {
  console.error(
    'usage: pr-watch.mjs <pr> [--repo owner/name] [--minutes N] [--interval S] [--exit-on-ci]',
  );
  process.exit(2);
}
const started = Date.now();
const minutes = Number(flag('--minutes') ?? 29);
const intervalMs = Number(flag('--interval') ?? 45) * 1000;
const exitOnCi = args.includes('--exit-on-ci');

const gh = (path, jq) => {
  // Bounded, so a cycle's three reads fit the 30s `fitsAnotherPoll` budgets for them: a hung call
  // would otherwise carry the last cycle past Monitor's cap. A timeout is a failed read, retried.
  const out = execFileSync('gh', ['api', path, ...(jq ? ['--jq', jq] : [])], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 9_000,
  });
  return JSON.parse(out);
};
const repo =
  flag('--repo') ??
  JSON.parse(
    execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner'], {
      encoding: 'utf8',
    }),
  ).nameWithOwner;

function snapshot() {
  const p = gh(
    `repos/${repo}/pulls/${pr}`,
    '{state: .state, merged: .merged, head: .head.sha}',
  );
  // CI is every workflow run on the head.
  const ciRuns = gh(
    `repos/${repo}/actions/runs?head_sha=${p.head}&per_page=100`,
    '[.workflow_runs[] | {head_sha, status, conclusion, name}]',
  );
  return {
    state: p.merged ? 'merged' : p.state,
    head: p.head,
    ciRuns,
  };
}

const say = (line) => console.log(line);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let state;
let failures = 0;
for (;;) {
  try {
    state = primeState(snapshot());
    break;
  } catch (e) {
    if (++failures >= 5) {
      say(
        `#${pr} watcher could not read the PR (${String(e.message ?? e).split('\n')[0]}): not watching`,
      );
      process.exit(1);
    }
    await sleep(10_000);
  }
}
say(
  `#${pr} watcher armed; reporting what comes next`,
);

const deadline = started + minutes * 60_000;
failures = 0;
while (fitsAnotherPoll(Date.now(), deadline, intervalMs)) {
  await sleep(intervalMs);
  let snap;
  try {
    snap = snapshot();
    failures = 0;
  } catch (e) {
    // One failed read is noise; five in a row is something the lane should hear about rather than a silence.
    if (++failures === 5)
      say(
        `#${pr} watcher has failed 5 reads in a row (${String(e.message ?? e).split('\n')[0]}); still trying`,
      );
    continue;
  }
  const out = watchStep(state, snap);
  state = out.state;
  for (const e of out.events) say(describe(pr, e));
  if (state.ended) process.exit(0);
  const ci = exitOnCi && out.events.find((e) => e.type === 'ci');
  if (ci) process.exit(ci.ok ? 0 : 1);
}
say(
  `#${pr} watcher TIMED OUT after ${minutes} min with the PR still open: re-arm it (nothing new since the last line)`,
);
