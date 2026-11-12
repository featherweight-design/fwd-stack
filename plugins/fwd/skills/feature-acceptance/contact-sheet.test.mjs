// node --test contact-sheet.test.mjs
// The step runner against a stand-in page: the ways a cell could photograph the wrong surface and
// still count as reached (an error page, a redirect, a back with nowhere to go) must fail it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyTheme,
  cellNote,
  checkLoaded,
  checkTheme,
  redactConsole,
  runStep,
} from './contact-sheet.mjs';
import { addSecret } from './inventory.mjs';

const BASE = 'https://staging.example.com';

/** A page that lands where told (or at `landAt`) with `status`, and keeps a back stack. */
function fakePage({ status = 200, landAt, dialogs = [], dataTheme } = {}) {
  let current = 'about:blank';
  const stack = [];
  const routes = [];
  return {
    routes,
    async route(pattern, handler) {
      routes.push({ pattern, handler });
    },
    // getByRole('dialog', { name }) resolves when a dialog's name matches, as Playwright would.
    getByRole(role, { name }) {
      const found = dialogs.some((d) =>
        name instanceof RegExp ? name.test(d) : d === name,
      );
      const locator = {
        first: () => locator,
        async waitFor() {
          if (!found) throw new Error(`Timeout waiting for ${role} ${name}`);
        },
      };
      return locator;
    },
    async evaluate(fn) {
      return fn.toString().includes('dataset.theme')
        ? (dataTheme ?? null)
        : undefined;
    },
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

test('goto: expectStatus photographs the error page it names, and fails on any other status', async () => {
  await run(fakePage({ status: 404 }), { goto: '/gone', expectStatus: 404 });
  await assert.rejects(
    run(fakePage({ status: 200 }), { goto: '/gone', expectStatus: 404 }),
    /expected HTTP 404, got 200/,
  );
  await assert.rejects(
    run(fakePage({ status: 500 }), { goto: '/gone', expectStatus: 404 }),
    /expected HTTP 404, got 500/,
  );
  // The default stays strict.
  await assert.rejects(
    run(fakePage({ status: 404 }), { goto: '/gone' }),
    /HTTP 404/,
  );
});

test('goto: expectRedirect accepts the redirect it names, and fails when the page stays or goes elsewhere', async () => {
  await run(fakePage({ landAt: `${BASE}/sign-in?next=/crew` }), {
    goto: '/crew',
    expectRedirect: '/sign-in',
  });
  await assert.rejects(
    run(fakePage(), { goto: '/crew', expectRedirect: '/sign-in' }),
    /landed on \/crew, not \/sign-in/,
  );
  await assert.rejects(
    run(fakePage({ landAt: 'https://accounts.example.com/sign-in' }), {
      goto: '/crew',
      expectRedirect: '/sign-in',
    }),
    /landed on https:\/\/accounts\.example\.com/,
  );
});

test('waitDialog: a regex, like clickRole name, with ${VAR} escaped', async () => {
  await run(fakePage({ dialogs: ['Filters and sort'] }), {
    waitDialog: '^Filters',
  });
  await run(fakePage({ dialogs: ['Filters'] }), { waitDialog: '^Filters$' });
  await assert.rejects(
    run(fakePage({ dialogs: ['Filters and sort'] }), {
      waitDialog: '^Filters$',
    }),
    /Timeout/,
  );
  await run(
    fakePage({ dialogs: ['Invite to The (Best) Crew'] }),
    { waitDialog: 'Invite to ${CREW}$' },
    { CREW: 'The (Best) Crew' },
  );
});

test('route: fulfils matching requests with the status and body, JSON for a non-string body', async () => {
  const page = fakePage();
  await run(page, {
    route: '**/api/feed',
    status: 503,
    body: { error: 'down' },
  });
  await run(page, { route: '**/api/ping', body: 'pong' });
  const answered = [];
  for (const r of page.routes)
    await r.handler({ fulfill: async (o) => answered.push(o) });
  assert.deepEqual(answered, [
    { status: 503, body: '{"error":"down"}', contentType: 'application/json' },
    { status: 200, body: 'pong' },
  ]);
  assert.deepEqual(
    page.routes.map((r) => r.pattern),
    ['**/api/feed', '**/api/ping'],
  );
});

test('a failed cell never prints an expanded value: redacted before the note is cut', async () => {
  const token = 'fake-cc-invite-7Hq2xL9pV4';
  const env = { CC_CREW_INVITE_TOKEN: token };
  // The app redirects the invite to sign-in, so the landing names the token.
  const error = await run(
    fakePage({ landAt: `${BASE}/sign-in/${token}` }),
    { goto: '/invite/${CC_CREW_INVITE_TOKEN}' },
    env,
  ).catch((e) => e);
  assert.ok(String(error).includes(token), 'the raw error does carry it');
  assert.ok(!cellNote(error).includes(token));
  assert.match(cellNote(error), /redacted CC_CREW_INVITE_TOKEN/);
  // A cut at the note's length can fall inside the token; it must not leave a prefix behind.
  const long = new Error(`${'x'.repeat(135)} at /invite/${token}`);
  assert.ok(!cellNote(long).includes(token.slice(0, 6)));
  // Playwright's own message quotes the URL it navigated to, URL-encoded.
  const pw = new Error(
    `page.goto: net::ERR_ABORTED at ${BASE}/invite/${encodeURIComponent(token)}`,
  );
  assert.ok(!cellNote(pw).includes(token));
});

test('checkTheme: a page that drew another theme fails the cell', async () => {
  await checkTheme(fakePage({ dataTheme: 'electric' }), {
    label: 'electric',
    dataTheme: 'electric',
  });
  await checkTheme(fakePage(), { label: 'dark', colorScheme: 'dark' });
  await checkTheme(fakePage(), null);
  await assert.rejects(
    checkTheme(fakePage({ dataTheme: 'light' }), {
      label: 'electric',
      dataTheme: 'electric',
    }),
    /drew data-theme="light", not "electric"/,
  );
});

test('applyTheme: cookies on the base, localStorage by an init script before the page runs', async () => {
  const calls = { cookies: [], init: [] };
  const context = {
    async addCookies(c) {
      calls.cookies.push(...c);
    },
    async addInitScript(fn, arg) {
      calls.init.push(arg);
    },
  };
  await applyTheme(
    context,
    {
      label: 'jade',
      cookies: [{ name: 'the99_theme', value: 'jade' }],
      storage: { 'cc-theme': 'jade' },
    },
    BASE,
  );
  assert.deepEqual(calls.cookies, [
    { name: 'the99_theme', value: 'jade', url: BASE },
  ]);
  assert.deepEqual(calls.init, [{ 'cc-theme': 'jade' }]);
  await applyTheme(context, null, BASE);
  assert.equal(calls.init.length, 1);
});

test('redactConsole: the project sign-in module printing through console is redacted, then restored', () => {
  addSecret('CC_CREW_INVITE_TOKEN', 'fake-console-tok-57721');
  const lines = [];
  const fake = {
    log: (...a) => lines.push(a.join(' ')),
    info: (...a) => lines.push(a.join(' ')),
    warn: (...a) => lines.push(a.join(' ')),
    error: (...a) => lines.push(a.join(' ')),
  };
  const original = fake.log;
  const restore = redactConsole(fake);
  fake.log('joined with fake-console-tok-57721');
  fake.error({ url: '/invite/fake-console-tok-57721' });
  restore();
  assert.equal(fake.log, original);
  assert.equal(lines.length, 2);
  for (const l of lines) {
    assert.ok(!l.includes('fake-console-tok-57721'), l);
    assert.match(l, /redacted CC_CREW_INVITE_TOKEN/);
  }
});

test('route: ${VAR} in the glob comes from the environment', async () => {
  const page = fakePage();
  await run(
    page,
    { route: '**/api/crews/${CREW}', status: 404 },
    { CREW: 'c1' },
  );
  assert.equal(page.routes[0].pattern, '**/api/crews/c1');
});

test('checkLoaded: a visible loading marker fails the cell; a hidden or absent one does not', async () => {
  const page = (visible) => ({
    locator: (sel) => ({
      first: () => ({
        isVisible: async () => {
          if (sel === '.broken') throw new Error('bad selector');
          return visible.includes(sel);
        },
      }),
    }),
  });
  await checkLoaded(page([]), ['[aria-busy="true"]', '.skeleton']);
  await checkLoaded(page(['.other']), ['[aria-busy="true"]']);
  await checkLoaded(page([]), []);
  await checkLoaded(page([]), ['.broken']);
  await assert.rejects(
    checkLoaded(page(['.skeleton']), ['[aria-busy="true"]', '.skeleton']),
    /still loading: \.skeleton is visible/,
  );
});

test('expectMeta: passes when a meta tag matches, and names what it found when none does', async () => {
  const metaPage = (tags) => ({
    async waitForFunction(fn, [n, p]) {
      const hit = tags.some(
        (t) =>
          (t.name === n || t.property === n) && new RegExp(p).test(t.content),
      );
      if (!hit) throw new Error('timeout');
    },
    async evaluate(fn, n) {
      return tags
        .filter((t) => t.name === n || t.property === n)
        .map((t) => t.content);
    },
  });
  const step = { expectMeta: 'robots', content: 'noindex' };
  await runStep(
    metaPage([{ name: 'robots', content: 'noindex, nofollow' }]),
    step,
    { base: BASE },
  );
  await assert.rejects(
    runStep(metaPage([{ name: 'robots', content: 'index' }]), step, {
      base: BASE,
    }),
    /meta robots: content \["index"\] does not match \/noindex\//,
  );
  await assert.rejects(
    runStep(metaPage([]), step, { base: BASE }),
    /meta robots: not on the page/,
  );
});
