// node --test model-pick.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { line, opusIn, parseArgs, pick } from './model-pick.mjs';

const free = { opusCount: () => 0, maxOpus: 1 };
const full = { opusCount: () => 1, maxOpus: 1 };
const blind = { opusCount: () => null, maxOpus: 1 };

test('orchestrator is opus and skips the cap', () => {
  const r = pick({ orchestrator: true, paths: ['src/auth.ts'] }, full);
  assert.equal(line(r), 'MODEL: opus — orchestrator');
});

test('a failed Sonnet attempt is opus and names the attempt', () => {
  const r = pick({ sonnetFailed: 'flaky sync bug', paths: ['a.ts'] }, free);
  assert.equal(r.model, 'opus');
  assert.match(line(r), /flaky sync bug/);
});

test('money, auth, migrations and security paths are opus and name the path', () => {
  for (const [p, c] of [
    ['src/lib/billing/charge.ts', 'money'],
    ['src/lib/auth.ts', 'auth'],
    ['drizzle/0001_init.sql', 'migrations'],
    ['src/lib/crypto/keys.ts', 'security'],
  ]) {
    const r = pick({ paths: ['README.md', p] }, free);
    assert.equal(r.model, 'opus');
    assert.equal(line(r), `MODEL: opus — ${c} path ${p}`);
  }
});

test('API routes alone, tests and docs are not opus', () => {
  for (const p of [
    'src/app/api/things/route.ts',
    'src/lib/billing/charge.test.ts',
    'docs/auth.md',
  ])
    assert.equal(pick({ paths: [p] }, full).model, 'sonnet');
});

test('subagent is sonnet, haiku when read-only; a risky path still wins', () => {
  assert.equal(pick({ subagent: true, paths: ['a.ts'] }, free).model, 'sonnet');
  assert.equal(
    pick({ subagent: true, readOnly: true, paths: [] }, free).model,
    'haiku',
  );
  assert.equal(
    pick({ subagent: true, paths: ['src/auth.ts'] }, free).model,
    'opus',
  );
});

test('default is sonnet', () => {
  assert.equal(
    line(pick({ paths: ['src/ui/button.tsx'] }, full)),
    'MODEL: sonnet — default',
  );
});

test('opus is queued when the slots are full', () => {
  const r = pick({ paths: ['src/auth.ts'] }, full);
  assert.equal(
    line(r),
    'MODEL: opus (queued for the Opus slot: 1/1 in use) — auth path src/auth.ts',
  );
});

test('an unreadable model skips the cap and says so', () => {
  const r = pick({ paths: ['src/auth.ts'] }, blind);
  assert.equal(r.model, 'opus');
  assert.ok(!r.queued);
  assert.match(line(r), /cap not checked/);
});

test('opusIn counts Opus sessions, not this one, and is null when blind', () => {
  const l = (session, model) => ({ session, model });
  assert.equal(
    opusIn([l('a', 'claude-opus-5-5'), l('b', 'claude-sonnet-5-5')]),
    1,
  );
  assert.equal(
    opusIn([l('me', 'claude-opus-5-5'), l('b', 'claude-sonnet-5-5')], 'me'),
    0,
  );
  assert.equal(opusIn([l('a', null)]), null);
});

test('parseArgs reads flags and paths', () => {
  assert.deepEqual(
    parseArgs([
      '--sonnet-failed',
      'x',
      '--subagent',
      '--read-only',
      '--json',
      'a',
      'b',
    ]),
    {
      paths: ['a', 'b'],
      sonnetFailed: 'x',
      subagent: true,
      readOnly: true,
      json: true,
    },
  );
});
