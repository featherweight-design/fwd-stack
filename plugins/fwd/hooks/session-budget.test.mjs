// node --test session-budget.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  band,
  budgetMessage,
  crossed,
  lastContext,
  lines,
} from './session-budget.mjs';

const L = lines({});

test('the lines default to 150k and rotateAt, and follow the config', () => {
  assert.deepEqual(L, { warn: 150_000, critical: 450_000 });
  assert.deepEqual(
    lines({
      sessionBudget: { warnTokens: 80_000 },
      orchestrator: { rotateAt: 200_000 },
    }),
    { warn: 80_000, critical: 200_000 },
  );
  assert.deepEqual(lines({ orchestrator: { rotateAt: 100_000 } }), {
    warn: 100_000,
    critical: 100_000,
  });
  assert.match(
    budgetMessage(120_000, lines({ orchestrator: { rotateAt: 100_000 } })),
    /CRITICAL/,
    'a rotation line below the default warning still speaks',
  );
});

test('quiet below the warning line, then a warning, then critical', () => {
  assert.equal(budgetMessage(null, L), null);
  assert.equal(budgetMessage(149_999, L), null);
  assert.match(budgetMessage(150_000, L), /WARNING.*~150k/);
  assert.match(budgetMessage(462_000, L), /CRITICAL.*~462k.*rotate/);
});

test('bands: one for the warning, one for critical, then one per 100k past it', () => {
  assert.deepEqual(
    [0, 149_999, 150_000, 449_999, 450_000, 549_999, 550_000, 930_000].map(
      (c) => band(c, L),
    ),
    [0, 0, 1, 1, 2, 2, 3, 6],
  );
});

test('a session is told once per band crossed, never again for the same band', () => {
  const env = { CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'budget-')) };
  assert.equal(crossed('s1', 1, 10, env), true);
  assert.equal(crossed('s1', 1, 11, env), false);
  assert.equal(crossed('s1', 2, 12, env), true);
  assert.equal(crossed('s1', 2, 13, env), false);
  assert.equal(crossed('s2', 1, 10, env), true, 'sessions are tracked apart');
  assert.equal(
    crossed('s1', 1, 11, env),
    false,
    'a stale reading does not undo a newer band',
  );
  assert.equal(crossed('s1', 2, 14, env), false, 'so band 2 stays announced');
  assert.equal(
    crossed('s1', 0, 20, env),
    false,
    'a compacted session drops back',
  );
  assert.equal(
    crossed('s1', 1, 21, env),
    true,
    'and is warned again as it grows',
  );
});

test('parallel hook processes announce a band once between them', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'budget-')),
  };
  const script = `import { crossed } from ${JSON.stringify(new URL('./session-budget.mjs', import.meta.url).href)}; process.stdout.write(String(crossed('race', 2, 100)));`;
  const outs = await Promise.all(
    Array.from({ length: 8 }, () =>
      run(process.execPath, ['--input-type=module', '-e', script], { env }),
    ),
  );
  assert.equal(outs.filter((o) => o.stdout === 'true').length, 1);
});

test('context is the last main-session turn, read from the tail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'budget-'));
  const file = join(dir, 't.jsonl');
  const turn = (input, cached, extra = {}) =>
    JSON.stringify({
      type: 'assistant',
      message: {
        id: String(input),
        usage: {
          input_tokens: input,
          cache_read_input_tokens: cached,
          cache_creation_input_tokens: 0,
        },
      },
      ...extra,
    });
  writeFileSync(
    file,
    [
      turn(10, 100_000),
      turn(20, 250_000),
      turn(5, 900_000, { isSidechain: true }),
      'x'.repeat(3 * 1024 * 1024),
      '{"type":"user"}',
    ].join('\n'),
  );
  assert.equal(
    lastContext(file).context,
    250_020,
    'a subagent turn does not count; a big tool result is read past',
  );
});

test('while the user is away both lines say keep working, never rotate or stop', () => {
  const l = { warn: 150_000, critical: 450_000 };
  for (const context of [200_000, 500_000, 900_000]) {
    const m = budgetMessage(context, l, true);
    assert.match(m, /USER AWAY/);
    assert.match(m, /keep working/);
    assert.match(m, /rotation line does not apply while they are away/);
    assert.match(m, /Never stop, or ask to stop, for context/);
    assert.doesNotMatch(m, /rotation at/);
    assert.doesNotMatch(m, /ask the orchestrator to rotate/);
  }
  assert.equal(
    budgetMessage(149_999, l, true),
    null,
    'quiet below the warning line',
  );
  assert.match(budgetMessage(200_000, l), /WARNING.*rotation at 450k/);
  assert.match(budgetMessage(500_000, l), /CRITICAL/);
});

test('switching between away and present announces the band again', () => {
  const env = { CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'budget-')) };
  assert.equal(crossed('m', 2, 10, env), true);
  assert.equal(crossed('m', 2, 11, env, true), true, 'present to away');
  assert.equal(crossed('m', 2, 12, env, true), false);
  assert.equal(crossed('m', 2, 13, env), true, 'away back to present');
  assert.equal(crossed('m', 2, 14, env), false);
});
