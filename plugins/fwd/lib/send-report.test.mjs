import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, markdownToHtml, sendReport } from './send-report.mjs';

const env = (extra = {}) => ({
  CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'report-')),
  ...extra,
});
const full = {
  RESEND_API_KEY: 're_test',
  EMAIL_FROM: 'a@example.com',
  REPORT_EMAIL_TO: 'b@example.com',
};

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
    }),
  );
  const config = loadConfig(e);
  assert.equal(config.RESEND_API_KEY, 're_env');
  assert.equal(config.EMAIL_FROM, 'f@example.com');
  assert.throws(
    () => loadConfig(env({ RESEND_API_KEY: 'x' })),
    /EMAIL_FROM, REPORT_EMAIL_TO/,
  );
});

test('markdown renders headings, tables, lists and links, and escapes html', () => {
  const html = markdownToHtml(
    '## Ship <b>\n\n| PR | What |\n| --- | --- |\n| [x](https://e.com/1) | **y** |\n\n1. do `it`\n2. then',
  );
  assert.match(html, /<h2>Ship &lt;b&gt;<\/h2>/);
  assert.match(html, /<th>PR<\/th>/);
  assert.match(
    html,
    /<td><a href="https:\/\/e.com\/1">x<\/a><\/td><td><strong>y<\/strong><\/td>/,
  );
  assert.match(html, /<ol><li>do <code>it<\/code><\/li><li>then<\/li><\/ol>/);
});

test('sendReport posts to Resend with the key and both bodies', async () => {
  let call;
  const result = await sendReport(
    { subject: '[done] run', body: '# hi' },
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
    [sent.to, sent.from, sent.subject, sent.text],
    ['b@example.com', 'a@example.com', '[done] run', '# hi'],
  );
  assert.match(sent.html, /<h1>hi<\/h1>/);
});

test('a Resend failure throws with its status', async () => {
  await assert.rejects(
    sendReport(
      { subject: 's', body: 'b' },
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
