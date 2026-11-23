// The hook end to end for the away-window rule. The gate is a stub that records its call and exits
// 1 (denies, with a marker), so a denial WITHOUT the marker came from the away rule or the hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { setAway } from '../../lib/away.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'gate-hook-away-')));
const plugin = join(root, 'plugin');
const skill = join(plugin, 'skills', 'pr-review');
mkdirSync(skill, { recursive: true });
mkdirSync(join(plugin, 'lib'));
for (const f of [
  'gate-hook.sh',
  'parse-command.mjs',
  'gate-path.mjs',
  'away-merge.mjs',
])
  copyFileSync(join(here, f), join(skill, f));
for (const f of ['is-main.mjs', 'away.mjs', 'plugin-data.mjs'])
  copyFileSync(join(here, '..', '..', 'lib', f), join(plugin, 'lib', f));
writeFileSync(
  join(skill, 'pr-gate.mjs'),
  "console.log('GATE RAN'); process.exit(1);\n",
);
const bareHome = join(root, 'home');
mkdirSync(bareHome);

const M = 'gh pr ' + 'merge';
const dataDir = () => mkdtempSync(join(root, 'data-'));
const hook = (command, data, { skillDir = skill } = {}) => {
  const env = { ...process.env, HOME: bareHome, CLAUDE_PLUGIN_DATA: data };
  delete env.GH_REPO;
  delete env.CLAUDE_CONFIG_DIR;
  const r = spawnSync('bash', [join(skillDir, 'gate-hook.sh')], {
    cwd: root,
    env,
    encoding: 'utf8',
    input: JSON.stringify({ cwd: root, tool_input: { command } }),
  });
  assert.equal(r.status, 0, r.stderr);
  if (r.stdout.trim() === '') return { allowed: true };
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny');
  return { allowed: false, reason: out.permissionDecisionReason };
};
const away = (data) => setAway(2, { CLAUDE_PLUGIN_DATA: data });

const AUTO = `${M} 42 --repo o/r --auto`;
const ADMIN = `${M} 42 --repo o/r --admin`;
const GQL_QUEUE = `gh api graphql -f query='mutation { enqueuePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }'`;
const GQL_AUTO = `gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: "x"}) { clientMutationId } }'`;

test('away: --auto, --admin and the GraphQL queue mutations are denied with the way out', () => {
  const d = dataDir();
  away(d);
  for (const cmd of [AUTO, ADMIN, GQL_QUEUE, GQL_AUTO]) {
    const r = hook(cmd, d);
    assert.equal(r.allowed, false, cmd);
    assert.match(r.reason, /user is away/, cmd);
    assert.match(r.reason, /wait for the user/, cmd);
  }
});

test('away: a flagged merge inside a chain is denied', () => {
  const d = dataDir();
  away(d);
  assert.equal(hook(`${M} 7 --repo o/r && ${AUTO}`, d).allowed, false);
});

test('away: a plain merge still goes to the gate', () => {
  const d = dataDir();
  away(d);
  const r = hook(`${M} 42 --repo o/r --squash`, d);
  assert.match(r.reason, /GATE RAN/);
});

test('present: flagged merges are not denied by the away rule', () => {
  const d = dataDir();
  for (const cmd of [AUTO, ADMIN]) {
    const r = hook(cmd, d);
    assert.doesNotMatch(r.reason ?? '', /away window/);
  }
  // A GraphQL mutation names no PR the gate can read, so a present user's line is simply allowed.
  assert.equal(hook(GQL_QUEUE, d).allowed, true);
});

test('a damaged away file denies the flagged forms and not the plain one', () => {
  const d = dataDir();
  writeFileSync(join(d, 'away.json'), '{"until":');
  assert.match(hook(AUTO, d).reason, /cannot be read/);
  assert.match(hook(GQL_QUEUE, d).reason, /cannot be read/);
  assert.doesNotMatch(
    hook(`${M} 42 --repo o/r`, d).reason ?? '',
    /cannot be read/,
  );
});

test('fail closed: if the away check cannot run, a flagged merge is denied', () => {
  // A copy of the hook with no away-merge.mjs beside it: node fails, and the hook must deny.
  const broken = join(root, 'broken', 'skills', 'pr-review');
  mkdirSync(broken, { recursive: true });
  mkdirSync(join(root, 'broken', 'lib'));
  for (const f of ['gate-hook.sh', 'parse-command.mjs', 'gate-path.mjs'])
    copyFileSync(join(here, f), join(broken, f));
  copyFileSync(
    join(here, '..', '..', 'lib', 'is-main.mjs'),
    join(root, 'broken', 'lib', 'is-main.mjs'),
  );
  writeFileSync(
    join(broken, 'pr-gate.mjs'),
    "console.log('GATE RAN'); process.exit(1);\n",
  );
  const d = dataDir();
  const r = hook(AUTO, d, { skillDir: broken });
  assert.equal(r.allowed, false);
});
