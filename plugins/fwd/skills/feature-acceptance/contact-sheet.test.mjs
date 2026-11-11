// node --test contact-sheet.test.mjs
// The step runner against a stand-in page: the ways a cell could photograph the wrong surface and
// still count as reached (an error page, a redirect, a back with nowhere to go) must fail it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runStep } from './contact-sheet.mjs';

const BASE = 'https://staging.example.com';

/** A page that lands where told (or at `landAt`) with `status`, and keeps a back stack. */
function fakePage({ status = 200, landAt } = {}) {
  let current = 'about:blank';
  const stack = [];
  return {
    async goto(url) {
      stack.push(current);
      current = landAt ?? url;
      return { status: () => status };
    },
    url: () => current,
    async goBack() {
      if (stack.length === 0) return null;
      current = stack.pop();
      return {};
    },
  };
}
const run = (page, step, env = {}) =>
  runStep(page, step, { base: BASE, scope: 'main', env });

test('goto: a page that loads where asked is reached', async () => {
  const page = fakePage();
  await run(page, { goto: '/projects' });
  assert.equal(page.url(), `${BASE}/projects`);
});

test('goto: a trailing slash or a query is not a redirect', async () => {
  await run(fakePage({ landAt: `${BASE}/projects/` }), { goto: '/projects' });
  await run(fakePage(), { goto: '/projects?tab=all' });
});

test('goto: an error status fails the cell', async () => {
  await assert.rejects(
    run(fakePage({ status: 404 }), { goto: '/gone' }),
    /HTTP 404/,
  );
  await assert.rejects(
    run(fakePage({ status: 500 }), { goto: '/' }),
    /HTTP 500/,
  );
});

test('goto: a redirect to sign-in, or to another origin, fails the cell', async () => {
  await assert.rejects(
    run(fakePage({ landAt: `${BASE}/sign-in?next=/projects` }), {
      goto: '/projects',
    }),
    /landed on \/sign-in/,
  );
  await assert.rejects(
    run(fakePage({ landAt: 'https://accounts.example.com/login' }), {
      goto: '/projects',
    }),
    /landed on https:\/\/accounts\.example\.com\/login/,
  );
});

test('goto: ${VAR} comes from the environment, and a missing one fails', async () => {
  const page = fakePage();
  await run(page, { goto: '/decks/${DECK}' }, { DECK: '42' });
  assert.equal(page.url(), `${BASE}/decks/42`);
  await assert.rejects(
    run(fakePage(), { goto: '/decks/${DECK}' }, {}),
    /needs DECK/,
  );
});

test('back: with nowhere to go it fails, rather than photograph the same page', async () => {
  await assert.rejects(
    run(fakePage(), { back: true }),
    /no page to go back to/,
  );
  const page = fakePage();
  await run(page, { goto: '/a' });
  await run(page, { goto: '/b' });
  await run(page, { back: true });
  assert.equal(page.url(), `${BASE}/a`);
});
