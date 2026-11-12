// node --test background-waits.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingWakes } from './background-waits.mjs';

const T0 = Date.parse('2026-11-12T01:00:00Z');
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const result = (min, text) =>
  JSON.stringify({
    type: 'user',
    timestamp: at(min),
    message: { content: [{ type: 'tool_result', content: text }] },
  });
const note = (min, id, status) =>
  JSON.stringify({
    type: 'user',
    timestamp: at(min),
    message: {
      content: `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<output-file>/tmp/${id}.output</output-file>\n<status>${status}</status>\n</task-notification>`,
    },
  });
const wake = (min, input) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: at(min),
    message: {
      content: [{ type: 'tool_use', name: 'ScheduleWakeup', input }],
    },
  });
const launch = (min, id) =>
  result(
    min,
    `Command running in background with ID: ${id}. Output is being written to: /tmp/${id}.output.`,
  );
const lines = (...l) => l.join('\n');

test('a background command not yet heard from is pending', () => {
  assert.deepEqual(pendingWakes(launch(0, 'b1'), T0 + 60_000).tasks, ['b1']);
});

test('a completed, failed or killed command is not pending', () => {
  for (const status of ['completed', 'failed', 'killed'])
    assert.deepEqual(
      pendingWakes(lines(launch(0, 'b1'), note(5, 'b1', status)), T0 + 600_000)
        .tasks,
      [],
    );
});

test('only the unfinished command of several is pending', () => {
  const t = lines(launch(0, 'b1'), launch(1, 'b2'), note(5, 'b1', 'completed'));
  assert.deepEqual(pendingWakes(t, T0 + 600_000).tasks, ['b2']);
});

test('a launch older than the age limit is treated as dead', () => {
  assert.deepEqual(pendingWakes(launch(0, 'b1'), T0 + 7 * 3_600_000).tasks, []);
});

test('a due ScheduleWakeup is pending until its time, and stop clears it', () => {
  const w = wake(0, { delaySeconds: 600, prompt: 'x' });
  assert.equal(pendingWakes(w, T0 + 60_000).wakeUntil, T0 + 600_000);
  assert.equal(pendingWakes(w, T0 + 601_000).wakeUntil, null);
  assert.equal(
    pendingWakes(lines(w, wake(1, { stop: true })), T0 + 120_000).wakeUntil,
    null,
  );
});

test('an empty or unparseable transcript has nothing pending', () => {
  assert.deepEqual(pendingWakes('', T0), { tasks: [], wakeUntil: null });
  assert.deepEqual(pendingWakes('{not json', T0), {
    tasks: [],
    wakeUntil: null,
  });
});
