#!/usr/bin/env node
// Lists, and with --apply removes, a repository's git worktrees that are safe to delete. Stale
// worktrees pile up (one project once had hundreds, each with its own node_modules for fseventsd
// to watch) until the machine runs out of memory. Agent-isolation worktrees under .claude/worktrees/
// are ordinary worktrees, so they are covered too.
//
//   node worktree-prune.mjs <repo> [--apply] [--no-fetch] [--min-age-hours=2]
//
// A dry run by default. A worktree is removed only when all of these hold:
//   - it is not the main checkout and is not locked;
//   - `git status` shows no change and no untracked file (ignored files such as node_modules do
//     not count, and `git worktree remove` deletes them with the directory);
//   - every commit on it is on origin: on its origin branch, or, for a branch gone from origin, on
//     the default branch or the head of one of its PRs (a squash-merged branch is deleted and its
//     commits never reach main);
//   - its branch's PR is merged or closed (any open PR keeps it), or the branch has no PR, is gone
//     from origin, is fully merged, and has not moved for --min-age-hours (so a lane's fresh,
//     still-empty worktree survives);
//   - no process has its cwd inside it.
// A worktree whose directory is already gone (prunable) is always pruned. Branches are never
// deleted. Prints one line per worktree (action, path, branch, reason), then a JSON summary whose
// needsHuman list names kept worktrees that look abandoned: uncommitted or unpushed work on a
// branch whose PR is done.
import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

import { isMain } from './is-main.mjs';

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const gitIn = (dir, ...args) => {
  try {
    return run('git', ['-C', dir, ...args]);
  } catch {
    return null;
  }
};

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

const tilde = (p) => {
  const home = homedir();
  return p === home || p.startsWith(home + sep)
    ? `~${p.slice(home.length)}`
    : p;
};

// `git worktree list --porcelain`: blocks separated by a blank line; the first is the main checkout.
export function parseWorktrees(porcelain) {
  return porcelain
    .split(/\n\n+/)
    .filter((b) => b.trim())
    .map((block) => {
      const w = {};
      for (const line of block.split('\n')) {
        const i = line.indexOf(' ');
        if (i < 0) w[line] = true;
        else w[line.slice(0, i)] = line.slice(i + 1);
      }
      return {
        path: w.worktree,
        branch:
          typeof w.branch === 'string'
            ? w.branch.replace(/^refs\/heads\//, '')
            : null,
        bare: Boolean(w.bare),
        locked: 'locked' in w,
        prunable: 'prunable' in w,
      };
    });
}

// One branch can have several PRs (a branch name reused after a merge, a closed attempt and a
// reopened one). Any open PR keeps the worktree; otherwise merged beats closed.
export function prStateOf(nodes = []) {
  const states = new Set(nodes.map((n) => n.state));
  for (const s of ['OPEN', 'MERGED', 'CLOSED']) if (states.has(s)) return s;
  return null;
}

// One GraphQL request per chunk of branches, by alias, so hundreds of worktrees cost a handful of
// calls and no PR list limit can drop an old branch.
export function prQuery(branches) {
  const fields = branches
    .map(
      (b, i) =>
        `b${i}: pullRequests(headRefName: ${JSON.stringify(b)}, first: 50, states: [OPEN, MERGED, CLOSED]) { nodes { state headRefOid } }`,
    )
    .join('\n    ');
  return `query($owner: String!, $name: String!) {\n  repository(owner: $owner, name: $name) {\n    ${fields}\n  }\n}`;
}

export function ghPrLookup(repo, chunk = 40) {
  return (branches) => {
    const map = new Map();
    if (!branches.length) return map;
    const [owner, name] = run(
      'gh',
      ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
      repo,
    ).split('/');
    for (let i = 0; i < branches.length; i += chunk) {
      const part = branches.slice(i, i + chunk);
      const out = JSON.parse(
        run(
          'gh',
          [
            'api',
            'graphql',
            '-f',
            `query=${prQuery(part)}`,
            '-f',
            `owner=${owner}`,
            '-f',
            `name=${name}`,
          ],
          repo,
        ),
      );
      const r = out.data.repository;
      part.forEach((b, j) => map.set(b, r[`b${j}`]?.nodes ?? []));
    }
    return map;
  };
}

// The cwd of every process we can see. lsof exits non-zero when it cannot read some processes but
// still prints the rest; with no output at all the check is unavailable and nothing is removed.
export function processCwds() {
  const r = spawnSync('lsof', ['-a', '-d', 'cwd', '-Fn'], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  if (!r.stdout) return null;
  return new Set(
    r.stdout
      .split('\n')
      .filter((l) => l.startsWith('n'))
      .map((l) => l.slice(1)),
  );
}

const DONE = new Set(['MERGED', 'CLOSED']);

// facts: { locked, prunable, busy, status, branch, onOrigin, ahead, prState, ageHours }
// status: null when unreadable, '' when clean. ahead: commits not on origin, null when unknown.
export function decide(f, { minAgeHours = 2 } = {}) {
  const keep = (reason, needsHuman = false) => ({
    action: 'keep',
    reason,
    needsHuman,
  });
  const remove = (reason) => ({ action: 'remove', reason, needsHuman: false });
  if (f.locked) return keep('locked');
  if (f.prunable) return remove('directory already gone');
  if (f.busy === null) return keep('cannot list process cwds');
  if (f.busy) return keep('in use: a process cwd is inside');
  const settled = f.ageHours === null || f.ageHours >= minAgeHours;
  const abandoned =
    DONE.has(f.prState) || (!f.prState && !f.onOrigin && settled);
  if (f.status === null) return keep('unreadable', true);
  if (f.status) return keep('uncommitted changes', abandoned);
  if (f.prState === 'OPEN') return keep('PR open');
  if (f.ahead === null) return keep('cannot compare with origin', true);
  if (f.ahead > 0) return keep(`${f.ahead} commit(s) not on origin`, abandoned);
  if (f.prState === 'MERGED') return remove('PR merged');
  if (f.prState === 'CLOSED') return remove('PR closed');
  if (f.branch && f.onOrigin) return keep('no PR, branch on origin');
  if (!settled) return keep(`no PR yet, moved under ${minAgeHours}h ago`);
  return remove(
    f.branch
      ? 'no PR, branch gone from origin and fully merged'
      : 'detached, fully merged',
  );
}

function ageHours(dir, now) {
  const gitDir = gitIn(dir, 'rev-parse', '--absolute-git-dir');
  if (!gitDir) return null;
  for (const f of ['logs/HEAD', 'HEAD']) {
    try {
      return (now - statSync(join(gitDir, f)).mtimeMs) / 3_600_000;
    } catch {
      // try the next one
    }
  }
  return null;
}

const STATUS = [
  'status',
  '--porcelain',
  '--untracked-files=all',
  '--ignore-submodules=none',
];

export function prune(repo, opts = {}) {
  const {
    apply = false,
    fetch = true,
    minAgeHours = 2,
    now = Date.now(),
    prLookup = ghPrLookup(repo),
    cwds = processCwds(),
  } = opts;
  if (fetch) run('git', ['-C', repo, 'fetch', '-q', '--prune', 'origin']);
  const all = parseWorktrees(
    run('git', ['-C', repo, 'worktree', 'list', '--porcelain']),
  );
  const main = all[0].path;
  const trees = all.slice(1).filter((w) => !w.bare);
  const head = gitIn(
    repo,
    'symbolic-ref',
    '-q',
    '--short',
    'refs/remotes/origin/HEAD',
  );
  const base = head || 'origin/main';
  const branches = [
    ...new Set(
      trees
        .filter((w) => w.branch && !w.prunable && !w.locked)
        .map((w) => w.branch),
    ),
  ];
  const prs = prLookup(branches);
  const busyIn = (path) => {
    if (cwds === null) return null;
    const p = real(path);
    for (const c of cwds) if (c === p || c.startsWith(p + sep)) return true;
    return false;
  };

  const results = [];
  for (const w of trees) {
    const facts = { locked: w.locked, prunable: w.prunable, branch: w.branch };
    if (!w.locked && !w.prunable) {
      const nodes = (w.branch && prs.get(w.branch)) || [];
      facts.busy = busyIn(w.path);
      facts.status = gitIn(w.path, ...STATUS);
      facts.prState = prStateOf(nodes);
      facts.onOrigin = Boolean(
        w.branch &&
        gitIn(
          repo,
          'rev-parse',
          '--verify',
          '-q',
          `refs/remotes/origin/${w.branch}`,
        ),
      );
      // Commits on HEAD that origin does not hold: not on the origin branch, or for a branch gone
      // from origin, not on the default branch nor the head of any of its PRs.
      const bases = facts.onOrigin
        ? [`refs/remotes/origin/${w.branch}`]
        : [
            base,
            ...nodes
              .map((n) => n.headRefOid)
              .filter(
                (oid) =>
                  oid &&
                  gitIn(repo, 'cat-file', '-e', `${oid}^{commit}`) !== null,
              ),
          ];
      const ahead = gitIn(
        w.path,
        'rev-list',
        '--count',
        'HEAD',
        '--not',
        ...bases,
      );
      facts.ahead = ahead === null ? null : Number(ahead);
      facts.ageHours = ageHours(w.path, now);
    }
    const d = decide(facts, { minAgeHours });
    const r = { path: w.path, branch: w.branch, ...d };
    if (apply && d.action === 'remove' && !w.prunable)
      r.removed = removeWorktree(main, w.path);
    results.push(r);
  }
  if (apply) gitIn(main, 'worktree', 'prune');
  return results;
}

// Never --force past a change. A plain remove refuses an unclean worktree but ignores ignored
// files; it also refuses any worktree with a submodule. Only then, and only if a fresh status is
// still clean, is it retried with --force (which never overrides a lock).
function removeWorktree(main, path) {
  if (gitIn(main, 'worktree', 'remove', path) !== null) return 'removed';
  if (gitIn(path, ...STATUS) !== '') return 'failed: changed since check';
  if (gitIn(main, 'worktree', 'remove', '--force', path) !== null)
    return 'removed';
  return 'failed';
}

export function summarise(repo, results, apply) {
  const counts = {};
  for (const r of results) {
    const key =
      r.action === 'keep'
        ? `keep: ${r.reason.replace(/^\d+ /, 'n ')}`
        : r.action;
    counts[key] = (counts[key] || 0) + 1;
  }
  const summary = {
    repo: tilde(repo),
    apply,
    total: results.length,
    ...counts,
  };
  if (apply) {
    summary.removed = results.filter(
      (r) => r.action === 'remove' && (r.removed ?? 'removed') === 'removed',
    ).length;
    const failed = results.filter((r) => r.removed && r.removed !== 'removed');
    if (failed.length)
      summary.failed = failed.map((r) => ({
        path: tilde(r.path),
        why: r.removed,
      }));
  }
  summary.needsHuman = results
    .filter((r) => r.needsHuman)
    .map((r) => ({ path: tilde(r.path), branch: r.branch, reason: r.reason }));
  return summary;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const repo = args.find((a) => !a.startsWith('--'));
  if (!repo) {
    console.error(
      'usage: worktree-prune.mjs <repo> [--apply] [--no-fetch] [--min-age-hours=2]',
    );
    process.exit(1);
  }
  const apply = args.includes('--apply');
  const age = args.find((a) => a.startsWith('--min-age-hours='));
  const minAgeHours = age ? Number(age.split('=')[1]) : 2;
  if (!(minAgeHours >= 0)) {
    console.error('--min-age-hours must be a number of hours');
    process.exit(1);
  }
  const results = prune(repo, {
    apply,
    fetch: !args.includes('--no-fetch'),
    minAgeHours,
  });
  for (const r of results) {
    const act =
      r.action === 'remove'
        ? apply
          ? (r.removed ?? 'removed')
          : 'remove'
        : 'keep';
    console.log(
      `${act.padEnd(6)} ${tilde(r.path)} [${r.branch || 'detached'}] ${r.reason}`,
    );
  }
  console.log(JSON.stringify(summarise(repo, results, apply)));
}
