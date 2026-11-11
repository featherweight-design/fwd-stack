// node --test worktree-prune.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  decide,
  parseWorktrees,
  prQuery,
  prStateOf,
  prune,
  summarise,
} from './worktree-prune.mjs';

test('parses the porcelain list: main first, branch, detached, locked, prunable', () => {
  const list = parseWorktrees(
    [
      'worktree /r\nHEAD aaa\nbranch refs/heads/main',
      'worktree /r-a\nHEAD bbb\nbranch refs/heads/feat/a\nlocked agent running',
      'worktree /r-b\nHEAD ccc\ndetached',
      'worktree /r-c\nHEAD ddd\nbranch refs/heads/fix/c\nprunable gitdir file points to non-existent location',
      '',
    ].join('\n\n'),
  );
  assert.equal(list.length, 4);
  assert.deepEqual(list[0], {
    path: '/r',
    branch: 'main',
    bare: false,
    locked: false,
    prunable: false,
  });
  assert.equal(list[1].branch, 'feat/a');
  assert.equal(list[1].locked, true);
  assert.equal(list[2].branch, null);
  assert.equal(list[3].prunable, true);
});

test('a branch with several PRs: any open wins, then merged, then closed', () => {
  assert.equal(prStateOf([]), null);
  assert.equal(prStateOf([{ state: 'CLOSED' }, { state: 'MERGED' }]), 'MERGED');
  assert.equal(prStateOf([{ state: 'MERGED' }, { state: 'OPEN' }]), 'OPEN');
  assert.equal(prStateOf([{ state: 'CLOSED' }]), 'CLOSED');
});

test('one aliased GraphQL query covers a chunk of branches, names escaped', () => {
  const q = prQuery(['feat/a', 'odd"name']);
  assert.match(q, /b0: pullRequests\(headRefName: "feat\/a"/);
  assert.match(q, /b1: pullRequests\(headRefName: "odd\\"name"/);
  assert.match(q, /states: \[OPEN, MERGED, CLOSED\]/);
});

const clean = {
  locked: false,
  prunable: false,
  busy: false,
  status: '',
  branch: 'feat/a',
  onOrigin: true,
  ahead: 0,
  prState: 'MERGED',
  ageHours: 50,
};

test('decide: removes only when every condition holds', () => {
  assert.equal(decide(clean).action, 'remove');
  assert.equal(decide({ ...clean, prState: 'CLOSED' }).action, 'remove');
  assert.equal(decide({ locked: true, prunable: true }).reason, 'locked');
  assert.equal(decide({ locked: false, prunable: true }).action, 'remove');
  assert.equal(decide({ ...clean, busy: true }).action, 'keep');
  assert.equal(decide({ ...clean, busy: null }).action, 'keep');
  assert.equal(decide({ ...clean, prState: 'OPEN' }).reason, 'PR open');
  assert.equal(decide({ ...clean, ahead: null }).action, 'keep');
  assert.equal(
    decide({ ...clean, prState: null }).reason,
    'no PR, branch on origin',
  );
});

test('decide: abandoned work is kept and flagged for a human', () => {
  const dirty = decide({ ...clean, status: '?? notes.txt' });
  assert.equal(dirty.action, 'keep');
  assert.equal(dirty.needsHuman, true);
  const ahead = decide({ ...clean, prState: 'CLOSED', ahead: 2 });
  assert.equal(ahead.action, 'keep');
  assert.equal(ahead.needsHuman, true);
  // Work in progress on an open PR is not abandoned.
  assert.equal(
    decide({ ...clean, prState: 'OPEN', status: ' M a' }).needsHuman,
    false,
  );
});

test('decide: a branch with no PR, gone from origin, needs to be merged and settled', () => {
  const gone = { ...clean, prState: null, onOrigin: false };
  assert.equal(decide(gone).action, 'remove');
  assert.equal(decide({ ...gone, ageHours: 0.5 }).action, 'keep');
  assert.equal(
    decide({ ...gone, ageHours: 0.5 }, { minAgeHours: 0 }).action,
    'remove',
  );
  assert.equal(decide({ ...gone, ahead: 1 }).action, 'keep');
  assert.equal(
    decide({ ...gone, branch: null }).reason,
    'detached, fully merged',
  );
});

test('summary counts actions and lists what needs a human', () => {
  const s = summarise(
    '/r',
    [
      {
        path: '/r-a',
        branch: 'a',
        action: 'remove',
        reason: 'PR merged',
        removed: 'removed',
      },
      {
        path: '/r-b',
        branch: 'b',
        action: 'keep',
        reason: '3 commit(s) not on origin',
        needsHuman: true,
      },
      {
        path: '/r-c',
        branch: 'c',
        action: 'remove',
        reason: 'PR merged',
        removed: 'failed',
      },
    ],
    true,
  );
  assert.equal(s.total, 3);
  assert.equal(s.remove, 2);
  assert.equal(s['keep: n commit(s) not on origin'], 1);
  assert.equal(s.removed, 1);
  assert.equal(s.failed.length, 1);
  assert.deepEqual(s.needsHuman, [
    { path: '/r-b', branch: 'b', reason: '3 commit(s) not on origin' },
  ]);
});

test('prune on a real repository: removes only the safe worktrees, keeps every branch', () => {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
  };
  const git = (dir, ...a) =>
    execFileSync('git', ['-C', dir, ...a], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fwd-wt-')));
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, repo);
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'remote', 'set-head', 'origin', 'main');

  const wt = (name, { commit = false, push = false } = {}) => {
    const path = join(root, name);
    git(repo, 'worktree', 'add', '-q', '-b', name, path, 'origin/main');
    if (commit) {
      writeFileSync(join(path, `${name}.txt`), name);
      git(path, 'add', '.');
      git(path, 'commit', '-qm', name);
    }
    if (push) git(path, 'push', '-q', 'origin', name);
    return path;
  };
  const merged = wt('merged', { commit: true, push: true });
  mkdirSync(join(merged, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(merged, 'node_modules', 'x', 'index.js'), '');
  const squashed = wt('squashed', { commit: true }); // branch deleted from origin after a squash merge
  const dirty = wt('dirty', { commit: true, push: true });
  writeFileSync(join(dirty, 'notes.txt'), 'wip');
  const ahead = wt('ahead', { commit: true, push: true });
  writeFileSync(join(ahead, 'more.txt'), 'more');
  git(ahead, 'add', '.');
  git(ahead, 'commit', '-qm', 'more');
  const open = wt('open', { commit: true, push: true });
  const fresh = wt('fresh');
  const busy = wt('busy', { commit: true, push: true });
  const locked = wt('locked', { commit: true, push: true });
  git(repo, 'worktree', 'lock', locked);
  const gone = wt('gone', { commit: true, push: true });
  rmSync(gone, { recursive: true, force: true });

  const head = (p) => git(p, 'rev-parse', 'HEAD');
  const prs = new Map([
    [
      'merged',
      [
        { state: 'CLOSED', headRefOid: null },
        { state: 'MERGED', headRefOid: head(merged) },
      ],
    ],
    ['squashed', [{ state: 'MERGED', headRefOid: head(squashed) }]],
    ['dirty', [{ state: 'MERGED', headRefOid: head(dirty) }]],
    ['ahead', [{ state: 'CLOSED', headRefOid: null }]],
    ['open', [{ state: 'OPEN', headRefOid: head(open) }]],
    ['busy', [{ state: 'MERGED', headRefOid: head(busy) }]],
  ]);
  const opts = { prLookup: () => prs, cwds: new Set([join(busy, 'src')]) };

  const dry = prune(repo, opts);
  const by = Object.fromEntries(dry.map((r) => [r.branch, r]));
  assert.equal(by.merged.action, 'remove');
  assert.equal(by.squashed.action, 'remove');
  assert.equal(by.dirty.action, 'keep');
  assert.equal(by.dirty.needsHuman, true);
  assert.equal(by.ahead.action, 'keep');
  assert.equal(by.ahead.needsHuman, true);
  assert.equal(by.open.reason, 'PR open');
  assert.equal(by.fresh.action, 'keep');
  assert.match(by.busy.reason, /in use/);
  assert.equal(by.locked.reason, 'locked');
  assert.equal(by.gone.action, 'remove');
  assert.ok(existsSync(merged), 'a dry run removes nothing');

  prune(repo, { ...opts, apply: true });
  assert.ok(!existsSync(merged), 'ignored node_modules does not block removal');
  assert.ok(!existsSync(squashed));
  for (const p of [dirty, ahead, open, fresh, busy, locked])
    assert.ok(existsSync(p), p);
  assert.doesNotMatch(git(repo, 'worktree', 'list', '--porcelain'), /\/gone\n/);
  for (const b of ['merged', 'squashed', 'gone'])
    git(repo, 'rev-parse', '--verify', '-q', `refs/heads/${b}`);

  const later = prune(repo, { ...opts, minAgeHours: 0 });
  assert.equal(later.find((r) => r.branch === 'fresh').action, 'remove');
  rmSync(root, { recursive: true, force: true });
});
