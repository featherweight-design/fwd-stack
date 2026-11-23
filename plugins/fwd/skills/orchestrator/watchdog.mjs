#!/usr/bin/env node
// The orchestrator's stall watchdog. Run it with the Bash tool's `run_in_background`: it polls
// GitHub (no model cost) and EXITS only when something needs the orchestrator, and that exit is
// what wakes the session:
//   - an open PR has been quiet for `--stall` minutes (default 30) and has not been reported since
//     it went quiet (a state file in the plugin's data folder remembers, so a re-arm does not exit
//     on the same PR again), or
//   - a transition since the last poll: a PR's checks finished (passed or failed), a PR merged, a PR
//     was closed unmerged, or a new review or comment arrived, or
//   - the heartbeat (every 2.5 hours by default), so idle lanes with queued work get checked even when nothing stalls.
// Every exit prints its class on the first line, `watchdog [class]: ...`: `event` (a transition),
// `quiet` (a PR past the threshold), `heartbeat` (the timer alone) or `error` (polls failing), so
// the orchestrator can react by class. The watchdog never messages a lane; the orchestrator acts.
// On every exit it prints the stalled PRs, a roadmap stale-check reminder and the lane-context
// table. Re-arm it after acting.
// A foreground wait loop blocks the user's messages behind it; never run this in the foreground.
//
//   node watchdog.mjs [--repo owner/name] [--stall 30] [--heartbeat 150] [--interval 120]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pluginDataDir } from '../../lib/plugin-data.mjs';
import {
  describeEvent,
  heldPrs,
  nextSnapshots,
  snapshots,
  stalledPrs,
  transitions,
  unreported,
  wakeClass,
} from './watchdog-core.mjs';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const repo = flag('repo');
const stall = Number(flag('stall', 30));
const heartbeat = Number(flag('heartbeat', 150));
const interval = Number(flag('interval', 120)) * 1000;

// gh lists 30 by default, drafts included. Ask for far more, and treat a full page as a partial
// list the orchestrator must hear about rather than a complete one.
const LIMIT = 1000;
// The latest poll's list, for the held-PR lines in a report.
let lastPrs = [];
const openPrs = () => {
  const prs = JSON.parse(
    execFileSync(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'open',
        '--json',
        'number,title,updatedAt,isDraft,headRefName,labels,statusCheckRollup,reviews,comments',
        '--limit',
        String(LIMIT),
        ...(repo ? ['--repo', repo] : []),
      ],
      { encoding: 'utf8', timeout: 30_000 },
    ),
  );
  if (prs.length >= LIMIT)
    report(
      'error',
      `${LIMIT}+ open PRs: the list is truncated, so stalls past it are unchecked`,
    );
  lastPrs = prs;
  return prs;
};

const laneTable = () => {
  try {
    return execFileSync(
      'node',
      [fileURLToPath(new URL('./lane-context.mjs', import.meta.url))],
      { encoding: 'utf8', timeout: 30_000 },
    );
  } catch {
    return '(lane-context unavailable)\n';
  }
};

// The whole report goes out in one write, and the process exits only once it has drained: a
// piped stdout can be cut short by an early exit, and the PRs in it are already marked reported.
let exiting = false;
const report = (kind, why, stalled = [], events = []) => {
  if (exiting) return; // one report per run
  const lines = [`watchdog [${kind}]: ${why}`, ...events.map(describeEvent)];
  for (const p of stalled)
    lines.push(
      `  #${p.number} quiet ${p.quietMinutes}m: ${p.title} (${p.headRefName})`,
    );
  for (const p of heldPrs(lastPrs, Date.now()))
    lines.push(
      `  held #${p.number} quiet ${Math.floor(p.quietMinutes / 60)}h: ${p.title}`,
    );
  exiting = true;
  // The wake is also the roadmap's stale-check benchmark (orchestrator skill §4).
  lines.push(
    'roadmap: run the stale check (orchestrator §4, benchmark 6), if the project has one',
  );
  process.stdout.write(`${lines.join('\n')}\n${laneTable()}`, () =>
    process.exit(0),
  );
};

// Keyed by repository, or by the working directory when gh infers it.
const stateDir = join(pluginDataDir(), 'watchdog');
const seenFile = join(
  stateDir,
  `fwd-watchdog-${(repo ?? process.cwd()).replace(/[^A-Za-z0-9]/g, '-')}.json`,
);
// The file is the quiet-PR memory (PR number -> updatedAt) plus one `snap` key: the last poll's
// snapshot per PR, which is what transitions are detected against.
const readSeen = () => {
  try {
    return JSON.parse(readFileSync(seenFile, 'utf8'));
  } catch {
    return {};
  }
};

// A PR that left the open list: merged or closed. A failed lookup returns nothing, so the PR is
// kept in the snapshot and tried again next poll.
const resolveGone = (prev, cur) => {
  const out = {};
  for (const n of Object.keys(prev))
    if (!cur[n])
      try {
        const v = JSON.parse(
          execFileSync(
            'gh',
            [
              'pr',
              'view',
              n,
              '--json',
              'state',
              ...(repo ? ['--repo', repo] : []),
            ],
            { encoding: 'utf8', timeout: 30_000 },
          ),
        );
        if (v.state === 'MERGED') out[n] = 'merged';
        else if (v.state === 'CLOSED') out[n] = 'closed';
      } catch {
        // retried next poll
      }
  return out;
};

const until = Date.now() + heartbeat * 60_000;
let failures = 0;
for (;;) {
  try {
    const prs = openPrs();
    if (exiting) break;
    const seen = readSeen();
    const stalled = unreported(stalledPrs(prs, Date.now(), stall), seen);
    for (const p of stalled) seen[p.number] = p.updatedAt;
    const cur = snapshots(prs);
    const resolved = resolveGone(seen.snap ?? {}, cur);
    const events = transitions(seen.snap, cur, resolved);
    const snap = nextSnapshots(seen.snap, cur, resolved);
    if (stalled.length || JSON.stringify(snap) !== JSON.stringify(seen.snap)) {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(seenFile, `${JSON.stringify({ ...seen, snap })}\n`);
    }
    if (stalled.length || events.length)
      report(
        wakeClass({ events, stalled }),
        [
          events.length && `${events.length} transition(s)`,
          stalled.length &&
            `${stalled.length} open PR(s) quiet for ${stall}+ minutes`,
        ]
          .filter(Boolean)
          .join(', '),
        stalled,
        events,
      );
    // Only a poll that got all the way through resets the count: a state write that fails every
    // time must still reach the five-failure alarm.
    failures = 0;
  } catch (e) {
    // A few failed reads are noise; a run of them is something the orchestrator should hear.
    if (++failures >= 5)
      report(
        'error',
        `GitHub unreadable 5 times running (${String(e.message).split('\n')[0]})`,
      );
  }
  if (!exiting && Date.now() + interval > until)
    report('heartbeat', 'heartbeat');
  if (exiting) break; // the write callback exits once stdout drains
  await new Promise((r) => setTimeout(r, interval));
}
