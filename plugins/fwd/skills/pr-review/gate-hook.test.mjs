// node --test gate-hook.test.mjs
// The hook end to end, outside any git checkout. The real gate needs the GitHub API, so the hook
// runs from a copy of this folder whose pr-gate.mjs is a stub that records how it was called and
// denies. Every case here is about WHICH repository and directory reach the gate, and that the
// hook still denies whenever none can be resolved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// A scratch tree that is not a git checkout: the session directory the hook runs in.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'gate-hook-')));
const outside = join(root, 'session');
mkdirSync(outside);
const checkout = join(root, 'checkout');
mkdirSync(checkout);

// plugin/skills/pr-review/{gate-hook.sh,parse-command.mjs,pr-gate.mjs stub} and plugin/lib/is-main.mjs,
// the layout parse-command.mjs imports from.
const plugin = join(root, 'plugin');
const skill = join(plugin, 'skills', 'pr-review');
mkdirSync(skill, { recursive: true });
mkdirSync(join(plugin, 'lib'));
copyFileSync(join(here, 'gate-hook.sh'), join(skill, 'gate-hook.sh'));
copyFileSync(join(here, 'parse-command.mjs'), join(skill, 'parse-command.mjs'));
copyFileSync(join(here, 'gate-path.mjs'), join(skill, 'gate-path.mjs'));
copyFileSync(
  join(here, '..', '..', 'lib', 'is-main.mjs'),
  join(plugin, 'lib', 'is-main.mjs'),
);
writeFileSync(
  join(skill, 'pr-gate.mjs'),
  "console.log('STUB ' + JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\nprocess.exit(1);\n",
);

// A home with no ~/.claude/fwd, so the hook runs the gate beside it unless a test says otherwise.
const bareHome = join(root, 'home');
mkdirSync(bareHome);

const hook = (command, { stub = true, home = bareHome } = {}) => {
  const script = stub
    ? join(skill, 'gate-hook.sh')
    : join(here, 'gate-hook.sh');
  const env = { ...process.env, HOME: home };
  delete env.GH_REPO;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
  const r = spawnSync('bash', [script], {
    cwd: outside,
    env,
    encoding: 'utf8',
    input: JSON.stringify({ cwd: outside, tool_input: { command } }),
  });
  assert.equal(r.status, 0, r.stderr);
  if (r.stdout.trim() === '') return { allowed: true };
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny');
  const stub_ = out.permissionDecisionReason.match(/STUB (\{.*\})/);
  return {
    allowed: false,
    reason: out.permissionDecisionReason,
    gate: stub_ ? JSON.parse(stub_[1]) : null,
  };
};

const M = 'gh pr ' + 'merge';

test('an explicit --repo reaches the gate even outside a checkout', () => {
  const r = hook(`${M} 42 --repo o/r --squash`);
  assert.deepEqual(r.gate.args, ['42', '--action', 'merge', '--repo', 'o/r']);
  assert.equal(r.gate.cwd, outside);
});

test('an explicit repository wins over a directory the hook cannot follow', () => {
  const r = hook(`cd - && ${M} 42 -R o/r`);
  assert.deepEqual(r.gate.args, ['42', '--action', 'merge', '--repo', 'o/r']);
});

test('an explicit repository wins over the directory the command cds into', () => {
  const r = hook(`cd ${checkout} && ${M} 42 --repo o/r`);
  assert.deepEqual(r.gate.args, ['42', '--action', 'merge', '--repo', 'o/r']);
  // The gate still starts there, for its push-landed check.
  assert.equal(r.gate.cwd, checkout);
});

test('the REST re-request names its repository in the path', () => {
  const r = hook(
    'gh api -X POST repos/o/r/pulls/42/requested_' + 'reviewers --input -',
  );
  assert.deepEqual(r.gate.args, [
    '42',
    '--action',
    'rerequest',
    '--repo',
    'o/r',
  ]);
});

test('with no repository named, the gate starts in the directory the command cds into', () => {
  const r = hook(`cd ${checkout} && ./scripts/request-copilot-review.sh 42`);
  assert.deepEqual(r.gate.args, ['42', '--action', 'rerequest']);
  assert.equal(r.gate.cwd, checkout);
});

test('with no repository named and no cd, the gate starts in the session directory', () => {
  const r = hook(`${M} 42`);
  assert.deepEqual(r.gate.args, ['42', '--action', 'merge']);
  assert.equal(r.gate.cwd, outside);
});

test('a directory the hook cannot follow, with no repository named, is denied before the gate', () => {
  const r = hook(`cd - && ${M} 42`);
  assert.equal(r.allowed, false);
  assert.equal(r.gate, null);
  assert.match(r.reason, /cannot follow/);
});

test('a cd into a directory that does not exist, with no repository named, is denied', () => {
  const r = hook(`cd ${join(root, 'missing')} && ${M} 42`);
  assert.equal(r.allowed, false);
  assert.equal(r.gate, null);
  assert.match(r.reason, /does not exist/);
});

test('the real gate, outside a checkout with no repository named, denies with the reason', () => {
  const r = hook(`${M} 42`, { stub: false });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /cannot tell which repository PR #42 is in/);
  assert.doesNotMatch(r.reason, /not a git repository/);
});

test('anything ungated is allowed without running the gate', () => {
  assert.deepEqual(hook('git status'), { allowed: true });
});

// A home whose ~/.claude/fwd links to a newer cached install with the given pr-gate.mjs.
function newestHome(name, gateSource) {
  const h = join(root, name);
  const version = join(
    h,
    '.claude',
    'plugins',
    'cache',
    'fwd-stack',
    'fwd',
    '9.9.9',
  );
  mkdirSync(join(version, 'skills', 'pr-review'), { recursive: true });
  const gate = join(version, 'skills', 'pr-review', 'pr-gate.mjs');
  writeFileSync(gate, gateSource);
  symlinkSync(version, join(h, '.claude', 'fwd'));
  return { home: h, gate };
}

test('the newest installed gate runs in place of the bundled one, and the denial names it', () => {
  const { home, gate } = newestHome(
    'home-newest',
    "console.log('NEWEST ' + process.argv.slice(2).join(' '));\nprocess.exit(1);\n",
  );
  const r = hook(`${M} 42 --repo o/r`, { home });
  assert.equal(r.allowed, false);
  assert.equal(r.gate, null, 'the bundled stub must not run');
  assert.match(r.reason, /NEWEST 42 --action merge --repo o\/r/);
  assert.ok(r.reason.includes(`(ran ${gate})`), r.reason);
});

test('a newest gate that passes allows the command', () => {
  const { home } = newestHome('home-pass', 'process.exit(0);\n');
  assert.deepEqual(hook(`${M} 42 --repo o/r`, { home }), { allowed: true });
});

test('a newest gate that crashes on load denies, never allows', () => {
  const { home, gate } = newestHome(
    'home-crash',
    "import './missing-module.mjs';\n",
  );
  const r = hook(`${M} 42 --repo o/r`, { home });
  assert.equal(r.allowed, false);
  assert.ok(r.reason.includes(`(ran ${gate})`), r.reason);
});

test('with no newest install the denial names the bundled gate', () => {
  const r = hook(`${M} 42 --repo o/r`);
  assert.ok(r.reason.includes(`(ran ${join(skill, 'pr-gate.mjs')})`), r.reason);
});

test('when the resolver is missing, the bundled gate still runs and denies', () => {
  // A plugin copy with no gate-path.mjs: `node gate-path.mjs` fails, and the hook must fall back.
  const bare = join(root, 'plugin-no-resolver');
  const bareSkill = join(bare, 'skills', 'pr-review');
  mkdirSync(bareSkill, { recursive: true });
  mkdirSync(join(bare, 'lib'));
  for (const f of ['gate-hook.sh', 'parse-command.mjs', 'pr-gate.mjs'])
    copyFileSync(join(skill, f), join(bareSkill, f));
  copyFileSync(
    join(plugin, 'lib', 'is-main.mjs'),
    join(bare, 'lib', 'is-main.mjs'),
  );
  const { home } = newestHome('home-no-resolver', 'process.exit(0);\n');
  const env = { ...process.env, HOME: home };
  delete env.GH_REPO;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
  const r = spawnSync('bash', [join(bareSkill, 'gate-hook.sh')], {
    cwd: outside,
    env,
    encoding: 'utf8',
    input: JSON.stringify({
      cwd: outside,
      tool_input: { command: `${M} 42 --repo o/r` },
    }),
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /STUB/);
  assert.ok(
    out.permissionDecisionReason.includes(
      `(ran ${join(bareSkill, 'pr-gate.mjs')})`,
    ),
    out.permissionDecisionReason,
  );
});
