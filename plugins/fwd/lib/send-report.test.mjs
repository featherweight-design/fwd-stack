import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  epicBar,
  loadConfig,
  renderHtml,
  renderText,
  sendReport,
  subjectFor,
} from './send-report.mjs';

const env = (extra = {}) => ({
  CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'report-')),
  ...extra,
});
const full = {
  RESEND_API_KEY: 're_test',
  EMAIL_FROM: 'a@example.com',
  REPORT_EMAIL_TO: 'b@example.com',
};

const sample = () => ({
  run: 'Sample run',
  headsUp: ['Staging deploy failed twice; the lane rolled back.'],
  projects: [
    {
      icon: '🧪',
      name: 'Sample App',
      epics: [{ name: 'Checkout, phase 2', done: 8, inProgress: 1, total: 10 }],
      also: '2 dependency updates',
      ready: [
        {
          what: 'Search filters',
          how: 'Open [the app](https://example.com/search) and filter by date.',
        },
        { what: 'Formatter run', change: 'code' },
      ],
      waiting: [
        {
          decision: 'Auth upgrade',
          pick: 'Close it',
          blocks: 'Nothing else',
        },
        { setup: 'Update the plugin' },
      ],
      inProgress: ['SDK upgrade'],
    },
    { name: 'Second App', ready: [{ what: 'Bump', change: 'dependency' }] },
  ],
  ideas: [{ icon: '🧪', text: 'Enforce formatting in CI' }],
  todo: { url: 'https://example.com/todo', label: 'To-do list' },
});

test('config comes from the environment', () => {
  assert.equal(loadConfig(env(full)).REPORT_EMAIL_TO, 'b@example.com');
});

test('config falls back to the plugin data file, and names what is missing', () => {
  const e = env({ RESEND_API_KEY: 're_env' });
  writeFileSync(
    join(e.CLAUDE_PLUGIN_DATA, 'report-email.json'),
    JSON.stringify({
      EMAIL_FROM: 'f@example.com',
      REPORT_EMAIL_TO: 't@example.com',
      REPORT_TODO_URL: 'https://example.com/list',
    }),
  );
  const config = loadConfig(e);
  assert.equal(config.RESEND_API_KEY, 're_env');
  assert.equal(config.EMAIL_FROM, 'f@example.com');
  assert.equal(config.REPORT_TODO_URL, 'https://example.com/list');
  assert.throws(
    () => loadConfig(env({ RESEND_API_KEY: 'x' })),
    /EMAIL_FROM, REPORT_EMAIL_TO/,
  );
});

test('subject comes from the counts, with [needs input] when blocked', () => {
  assert.equal(subjectFor(sample()), '✅ 3 ready · 🙋 2 need you · Sample run');
  assert.equal(
    subjectFor({ ...sample(), needsInput: true }),
    '[needs input] ✅ 3 ready · 🙋 2 need you · Sample run',
  );
});

test('the epic bar is 10 cells, counted like the progress chart', () => {
  assert.equal(
    epicBar({ done: 8, inProgress: 1, total: 10 }),
    '🟩'.repeat(8) + '🟨⬜',
  );
  assert.equal(epicBar({ done: 2, total: 2 }), '🟩'.repeat(10));
  assert.equal(
    epicBar({ done: 1, inProgress: 1, total: 3 }),
    '🟩🟩🟩🟨🟨🟨⬜⬜⬜⬜',
  );
});

test('html renders every section in order', () => {
  const html = renderHtml(sample());
  const order = [
    '>3</div><div style="font-size:12px">✅ ready',
    '>2</div><div style="font-size:12px">🙋 need you',
    '>1</div><div style="font-size:12px">🟡 in progress',
    '🚨 Heads up',
    '🧪 Sample App',
    'EPIC · Checkout, phase 2',
    '8 of 10 PRs',
    '➕ Also: 2 dependency updates',
    '✅ Ready to test',
    '<a href="https://example.com/search">the app</a>',
    'Code improvement, no visible change',
    '🙋 Waiting on you',
    'Close it',
    '🔧 Setup step:</strong> Update the plugin',
    '<strong>In progress:</strong> SDK upgrade',
    'Second App',
    'Dependency update, no visible change',
    'Nothing waiting on you',
    '💡 New ideas to place',
    '🧪 Enforce formatting in CI',
    '🟩 done · 🟨 in progress · ⬜ queued',
    '<a href="https://example.com/todo">To-do list</a>',
  ];
  let at = -1;
  for (const s of order) {
    const i = html.indexOf(s, at + 1);
    assert.ok(i > at, `missing or out of order: ${s}`);
    at = i;
  }
  assert.doesNotMatch(html, /<link|<style|class=/);
});

test('optional sections are left out when empty, and empty boxes say so', () => {
  const html = renderHtml({ projects: [{ name: 'Quiet App' }] });
  for (const s of ['Heads up', 'New ideas', 'EPIC', 'Also:', '📋']) {
    assert.ok(!html.includes(s), `should omit ${s}`);
  }
  assert.match(html, /Nothing ready to test/);
  assert.match(html, /Nothing waiting on you/);
  assert.match(html, /In progress:<\/strong> <span[^>]*>nothing/);
});

test('the footer link falls back to config, and needs an http url', () => {
  const r = { projects: [] };
  assert.match(
    renderHtml(r, { REPORT_TODO_URL: 'https://example.com/t' }),
    /<a href="https:\/\/example.com\/t">To-do list<\/a>/,
  );
  assert.ok(
    !renderHtml({ todo: { url: 'javascript:alert(1)' } }).includes('📋'),
  );
});

test('all text is escaped, and only http links become anchors', () => {
  const html = renderHtml({
    run: '<script>',
    headsUp: ['a & b "q"'],
    projects: [
      {
        name: '<b>App</b>',
        ready: [{ what: '<img>', how: '[x](javascript:alert(1))' }],
        waiting: [{ decision: '<i>', pick: 'p', blocks: 'b' }],
      },
    ],
    ideas: ['<u>idea</u>'],
  });
  assert.ok(!/<script>|<b>App|<img>|<i>|<u>/.test(html));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /a &amp; b &quot;q&quot;/);
  assert.ok(!html.includes('href="javascript'));
});

test('an unknown change kind is an error, not a blank cell', () => {
  assert.throws(
    () =>
      renderHtml({ projects: [{ ready: [{ what: 'x', change: 'misc' }] }] }),
    /unknown change kind: misc/,
  );
});

test('plain text carries the same sections, links spelled out', () => {
  const text = renderText(sample());
  for (const s of [
    '✅ 3 ready · 🙋 2 need you · 🟡 1 in progress',
    '🚨 HEADS UP',
    '== 🧪 Sample App ==',
    'EPIC · Checkout, phase 2: 🟩🟩🟩🟩🟩🟩🟩🟩🟨⬜ 8 of 10 PRs',
    'the app (https://example.com/search)',
    '- Formatter run: Code improvement, no visible change',
    '- Auth upgrade | My pick: Close it | Blocks: Nothing else',
    '- 🔧 Setup step: Update the plugin',
    '🟡 In progress: SDK upgrade',
    'Nothing waiting on you',
    '- 🧪 Enforce formatting in CI',
    '📋 To-do list: https://example.com/todo',
  ]) {
    assert.ok(text.includes(s), `missing: ${s}`);
  }
  assert.doesNotMatch(text, /<[a-z]/);
});

test('sendReport posts to Resend with the key, both bodies and the derived subject', async () => {
  let call;
  const result = await sendReport(
    { report: sample() },
    {
      env: env(full),
      fetchFn: async (url, init) => {
        call = { url, init };
        return { ok: true, json: async () => ({ id: 'abc' }) };
      },
    },
  );
  assert.equal(result.id, 'abc');
  assert.equal(call.url, 'https://api.resend.com/emails');
  assert.equal(call.init.headers.Authorization, 'Bearer re_test');
  const sent = JSON.parse(call.init.body);
  assert.deepEqual(
    [sent.to, sent.from, sent.subject],
    ['b@example.com', 'a@example.com', subjectFor(sample())],
  );
  assert.match(sent.html, /✅ Ready to test/);
  assert.match(sent.text, /== 🧪 Sample App ==/);
});

test('an explicit subject wins over the derived one', async () => {
  let sent;
  await sendReport(
    { subject: 'Custom', report: sample() },
    {
      env: env(full),
      fetchFn: async (_url, init) => {
        sent = JSON.parse(init.body);
        return { ok: true, json: async () => ({ id: 'x' }) };
      },
    },
  );
  assert.equal(sent.subject, 'Custom');
});

test('a Resend failure throws with its status', async () => {
  await assert.rejects(
    sendReport(
      { report: { projects: [] } },
      {
        env: env(full),
        fetchFn: async () => ({
          ok: false,
          status: 403,
          text: async () => 'nope',
        }),
      },
    ),
    /Resend 403: nope/,
  );
});

test('an epic with a bad count fails naming the epic', () => {
  assert.throws(
    () => epicBar({ name: 'Checkout', done: 3, total: 2 }),
    /epic Checkout: 3 \+ 0 is more than 2/,
  );
  assert.throws(() => epicBar({ name: 'Checkout' }), /epic Checkout:/);
});

test('bold markup inside a link url does not touch the href', () => {
  const html = renderHtml({
    headsUp: ['[a](https://example.com/**b**)'],
    projects: [],
  });
  assert.ok(!html.includes('href="https://example.com/&lt;strong'));
  assert.ok(!/href="[^"]*<strong/.test(html));
});

test('needsInput must be true, not merely truthy', () => {
  assert.ok(!subjectFor({ needsInput: 'false', projects: [] }).startsWith('['));
});

test('a bad report todo url falls back to the config one', () => {
  assert.match(
    renderHtml(
      { todo: { url: 'ftp://x' }, projects: [] },
      { REPORT_TODO_URL: 'https://example.com/c' },
    ),
    /href="https:\/\/example.com\/c"/,
  );
});

test('a null config file is treated as no file', () => {
  const e = env(full);
  writeFileSync(join(e.CLAUDE_PLUGIN_DATA, 'report-email.json'), 'null');
  assert.equal(loadConfig(e).EMAIL_FROM, 'a@example.com');
});

test('sendReport sets a timeout on the request', async () => {
  let init;
  await sendReport(
    { report: { projects: [] } },
    {
      env: env(full),
      fetchFn: async (_url, i) => {
        init = i;
        return { ok: true, json: async () => ({ id: 'x' }) };
      },
    },
  );
  assert.ok(init.signal instanceof AbortSignal);
});
