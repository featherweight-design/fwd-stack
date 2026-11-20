// node --test session-budget.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  band,
  budgetMessage,
  crossed,
  lastContext,
  lines,
} from './session-budget.mjs';

const L = lines({});

test('the lines default to 150k and the 300k compact window, and follow the config', () => {
  assert.deepEqual(L, { warn: 150_000, critical: 300_000, window: 300_000 });
  assert.deepEqual(
    lines({ sessionBudget: { warnTokens: 80_000, compactWindow: 200_000 } }),
    { warn: 80_000, critical: 200_000, window: 200_000 },
  );
  assert.deepEqual(lines({ sessionBudget: { compactWindow: 100_000 } }), {
    warn: 100_000,
    critical: 100_000,
    window: 100_000,
  });
  assert.match(
    budgetMessage(
      120_000,
      lines({ sessionBudget: { compactWindow: 100_000 } }),
    ),
    /PAST THE COMPACT WINDOW/,
    'a window below the default warning still speaks',
  );
});

test('a project rotateAt below the window stays its upper line; above it, the window rules', () => {
  const r = lines({ orchestrator: { rotateAt: 200_000 } });
  assert.deepEqual(r, { warn: 150_000, critical: 200_000, window: 300_000 });
  assert.match(
    budgetMessage(250_000, r),
    /PAST ROTATEAT.*200k.*rotate at the next PR boundary/,
  );
  assert.match(
    budgetMessage(250_000, r, true),
    /waits for the user's return.*never stop/,
  );
  assert.deepEqual(lines({ orchestrator: { rotateAt: 600_000 } }), L);
});

test('quiet below the warning line, then a warning, then past the window', () => {
  assert.equal(budgetMessage(null, L), null);
  assert.equal(budgetMessage(149_999, L), null);
  assert.match(budgetMessage(150_000, L), /WARNING.*~150k.*configured window/);
  const past = budgetMessage(320_000, L);
  assert.match(past, /PAST THE COMPACT WINDOW.*~320k.*autoCompactWindow/);
  assert.match(past, /"autoCompactWindow": 300000/);
});

test('no message asks for a rotation on size; rotation is for drift', () => {
  for (const context of [150_000, 320_000, 900_000])
    for (const away of [false, true]) {
      const m = budgetMessage(context, L, away);
      assert.match(m, /Keep turns lean/);
      assert.match(
        m,
        /Rotate only if this session has compacted several times and drifts/,
      );
      assert.doesNotMatch(
        m,
        /ask the orchestrator to rotate|rotation (at|line)/,
      );
    }
});

test('bands: one per 50k step from the warning line', () => {
  assert.deepEqual(
    [0, 149_999, 150_000, 199_999, 200_000, 250_000, 300_000, 930_000].map(
      (c) => band(c, L),
    ),
    [0, 0, 1, 1, 2, 3, 4, 16],
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

test('while the user is away every message says never stop for context', () => {
  for (const context of [200_000, 500_000, 900_000]) {
    const m = budgetMessage(context, L, true);
    assert.match(m, /USER AWAY/);
    assert.match(m, /never stop, or ask to stop, for context/);
  }
  assert.match(
    budgetMessage(700_000, L, true),
    /PAST THE COMPACT WINDOW — USER AWAY/,
    'away does not hide a session past the window',
  );
  assert.equal(
    budgetMessage(149_999, L, true),
    null,
    'quiet below the warning line',
  );
  assert.doesNotMatch(budgetMessage(200_000, L), /USER AWAY|never stop/);
});

test('switching between away and present announces the band again', () => {
  const env = { CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'budget-')) };
  assert.equal(crossed('m', 2, 10, env), true);
  assert.equal(crossed('m', 2, 11, env, true), true, 'present to away');
  assert.equal(crossed('m', 2, 12, env, true), false);
  assert.equal(crossed('m', 2, 13, env), true, 'away back to present');
  assert.equal(crossed('m', 2, 14, env), false);
});

test('as a hook, each event speaks once per 50k step and then stays quiet', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const dir = mkdtempSync(join(tmpdir(), 'budget-'));
  const transcript = join(dir, 't.jsonl');
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: join(dir, 'data'),
    FWD_AWAY_FILE: join(dir, 'no-away'),
  };
  const script = fileURLToPath(
    new URL('./session-budget.mjs', import.meta.url),
  );
  const fire = async (event, context) => {
    writeFileSync(
      transcript,
      JSON.stringify({
        type: 'assistant',
        message: {
          id: String(context),
          usage: {
            input_tokens: context,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      }) +
        '\n' +
        'x'.repeat(context / 1000),
    );
    const child = run(process.execPath, [script], { env });
    child.child.stdin.end(
      JSON.stringify({
        hook_event_name: event,
        session_id: 'hook-run',
        transcript_path: transcript,
      }),
    );
    return (await child).stdout;
  };
  assert.equal(await fire('UserPromptSubmit', 149_000), '');
  assert.match(await fire('UserPromptSubmit', 150_000), /~150k/);
  assert.equal(await fire('UserPromptSubmit', 160_000), '', 'same step');
  assert.equal(await fire('PostToolUse', 170_000), '', 'either event');
  assert.match(await fire('PostToolUse', 200_000), /additionalContext/);
  assert.equal(await fire('UserPromptSubmit', 210_000), '');
});
