// The hook end to end for the away-window rule. Two setups:
//  - a recording stub gate, to see exactly what the hook hands the gate (the flags, how often, and
//    that the flags line is never read as an action);
//  - the real hook and real gate, to see the away refusal itself. The refusal comes before any
//    GitHub read, so nothing here touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { setAway } from '../../lib/away.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'gate-hook-away-')));
const bareHome = join(root, 'home');
mkdirSync(bareHome);

// A copy of the hook folder whose gate is a stub: it appends its arguments to $STUB_LOG, then exits
// with $STUB_EXIT (default 0).
const stubSkill = join(root, 'plugin', 'skills', 'pr-review');
mkdirSync(stubSkill, { recursive: true });
mkdirSync(join(root, 'plugin', 'lib'));
for (const f of ['gate-hook.sh', 'parse-command.mjs', 'gate-path.mjs'])
  copyFileSync(join(here, f), join(stubSkill, f));
copyFileSync(
  join(here, '..', '..', 'lib', 'is-main.mjs'),
  join(root, 'plugin', 'lib', 'is-main.mjs'),
);
writeFileSync(
  join(stubSkill, 'pr-gate.mjs'),
  `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.STUB_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(Number(process.env.STUB_EXIT ?? 0));
`,
);

const M = 'gh pr ' + 'merge';
const dataDir = () => mkdtempSync(join(root, 'data-'));
const open = (d) => setAway(2, { CLAUDE_PLUGIN_DATA: d });

const runHook = (script, command, env) => {
  const r = spawnSync('bash', [script], {
    cwd: root,
    env: { ...process.env, HOME: bareHome, ...env },
    encoding: 'utf8',
    input: JSON.stringify({ cwd: root, tool_input: { command } }),
  });
  assert.equal(r.status, 0, r.stderr);
  if (r.stdout.trim() === '') return { allowed: true };
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny');
  return { allowed: false, reason: out.permissionDecisionReason };
};

// The stub: returns what the gate was called with, one entry per call.
const stub = (command, { exit = 0 } = {}) => {
  const log = join(root, `log-${Math.random().toString(36).slice(2)}`);
  writeFileSync(log, '');
  const r = runHook(join(stubSkill, 'gate-hook.sh'), command, {
    CLAUDE_PLUGIN_DATA: dataDir(),
    STUB_LOG: log,
    STUB_EXIT: String(exit),
  });
  const calls = readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return { ...r, calls };
};

// The real hook and gate, with a chosen data folder.
const real = (command, data) =>
  runHook(join(here, 'gate-hook.sh'), command, { CLAUDE_PLUGIN_DATA: data });

const AUTO = `${M} 42 --repo o/r --auto`;
const ADMIN = `${M} 42 --repo o/r --admin`;
const gql = (q) => `gh api graphql -f query='${q}'`;
const ENQUEUE = gql(
  'mutation { enqueuePullRequest(input: {pullRequestId: "x"}) { c } }',
);
const AUTOMERGE = gql(
  'mutation { enablePullRequestAutoMerge(input: {pullRequestId: "x"}) { c } }',
);
const DIRECT = gql(
  'mutation { mergePullRequest(input: {pullRequestId: "x"}) { c } }',
);
const REST_PUT =
  'gh api -X PUT repos/o/r/pulls/42/merge -f merge_method=squash';

test('the hook hands the flags to the gate, once per gated PR, and never reads the flags line as an action', () => {
  const r = stub(`${M} 7 --repo o/r; ${M} 8 --repo o/r --auto`);
  assert.deepEqual(r.calls, [
    ['7', '--action', 'merge', '--repo', 'o/r', '--merge-flags', 'auto'],
    ['8', '--action', 'merge', '--repo', 'o/r', '--merge-flags', 'auto'],
  ]);
});

test('a line with no flags reaches the gate exactly as before', () => {
  const r = stub(`${M} 42 --repo o/r --squash`);
  assert.deepEqual(r.calls, [['42', '--action', 'merge', '--repo', 'o/r']]);
});

test('a line with flags and no PR makes one flags-only call', () => {
  const r = stub(ENQUEUE);
  assert.deepEqual(r.calls, [
    ['--action', 'merge', '--flags-only', '--merge-flags', 'queue'],
  ]);
  assert.equal(r.allowed, true);
});

test('a plain GraphQL read, or a mere mention of a mutation name, never reaches the gate', () => {
  for (const cmd of [
    gql('{ viewer { login } }'),
    'grep -rn enqueuePullRequest src',
    'git commit -m "mention enablePullRequestAutoMerge"',
  ]) {
    const r = stub(cmd);
    assert.deepEqual(r.calls, [], cmd);
    assert.equal(r.allowed, true, cmd);
  }
});

test('fail closed: a gate that cannot run denies a flagged merge and a flags-only call', () => {
  assert.equal(stub(AUTO, { exit: 2 }).allowed, false);
  assert.equal(stub(ENQUEUE, { exit: 2 }).allowed, false);
});

test('away: every flagged form is denied with the way out', () => {
  const d = dataDir();
  open(d);
  for (const cmd of [AUTO, ADMIN, ENQUEUE, AUTOMERGE, DIRECT, REST_PUT]) {
    const r = real(cmd, d);
    assert.equal(r.allowed, false, cmd);
    assert.match(r.reason, /user is away/, cmd);
    assert.match(r.reason, /wait for the user/, cmd);
  }
});

test('away: a GraphQL call whose query cannot be read is denied', () => {
  const d = dataDir();
  open(d);
  for (const cmd of [
    'gh api graphql -F query=@q.graphql',
    'gh api graphql --input q.json',
    'gh api graphql -f query="$Q"',
    'gh api graphql -f query="$(cat q.graphql)"',
  ])
    assert.equal(real(cmd, d).allowed, false, cmd);
});

test('away: a flagged merge in the middle of a chain is denied', () => {
  const d = dataDir();
  open(d);
  assert.equal(real(`echo start; ${AUTO}; echo done`, d).allowed, false);
});

test('away: a mention of a mutation name in a grep or a commit is not denied', () => {
  const d = dataDir();
  open(d);
  for (const cmd of [
    'grep -rn enqueuePullRequest src',
    'git commit -m "mention mergePullRequest"',
    gql('{ viewer { login } }'),
  ])
    assert.equal(real(cmd, d).allowed, true, cmd);
});

test('present: GraphQL forms are allowed as before, and a flagged merge is not denied for the window', () => {
  const d = dataDir();
  for (const cmd of [ENQUEUE, DIRECT, 'gh api graphql -F query=@q.graphql'])
    assert.equal(real(cmd, d).allowed, true, cmd);
  const flagged = stub(AUTO);
  assert.equal(flagged.calls.length, 1);
});

test('a damaged away file denies the flagged forms and leaves the rest alone', () => {
  const d = dataDir();
  writeFileSync(join(d, 'away.json'), '{"until":');
  assert.match(real(AUTO, d).reason, /cannot be read/);
  assert.match(real(ENQUEUE, d).reason, /cannot be read/);
  assert.equal(real(gql('{ viewer { login } }'), d).allowed, true);
});
