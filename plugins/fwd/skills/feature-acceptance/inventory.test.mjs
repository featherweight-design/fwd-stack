// node --test inventory.test.mjs
// Every rule here guards a quiet pass: an inventory the contact sheet would run, photograph
// nothing or the wrong thing, and still exit 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  baseUrlError,
  expand,
  inventoryErrors,
  sharesErrors,
  sheetHtml,
  widthErrors,
} from './inventory.mjs';

const LABELS = ['phone', 'desktop'];
const row = (over = {}) => ({
  id: 'home',
  label: '/ home',
  steps: [{ goto: '/', wait: 'h1' }],
  ...over,
});
const inv = (over = {}) => ({ feature: 'Home', rows: [row()], ...over });
const errs = (i) => inventoryErrors(i, LABELS);

test('a minimal inventory is valid', () => {
  assert.deepEqual(errs(inv()), []);
});

test('no rows is an error, not a sheet with nothing on it', () => {
  assert.match(errs(inv({ rows: [] })).join(), /non-empty/);
  assert.match(errs({ feature: 'x' }).join(), /non-empty/);
});

test('an unknown verb fails: a typo is a step that silently does nothing', () => {
  const e = errs(inv({ rows: [row({ steps: [{ goto: '/', wiat: 'h1' }] })] }));
  assert.match(e.join(), /unknown verb "wiat"/);
});

test('a step with no verb, or an argument without its verb, fails', () => {
  assert.match(errs(inv({ rows: [row({ steps: [{}] })] })).join(), /no verb/);
  assert.match(
    errs(inv({ rows: [row({ steps: [{ goto: '/', name: 'Save' }] })] })).join(),
    /"name" belongs with "clickRole"/,
  );
  assert.match(
    errs(inv({ rows: [row({ steps: [{ clickRole: 'button' }] })] })).join(),
    /"clickRole" needs "name"/,
  );
});

test('an empty selector fails, since the step would silently not happen', () => {
  assert.match(
    errs(inv({ rows: [row({ steps: [{ click: '' }] })] })).join(),
    /non-empty string/,
  );
});

test('goto is a path, settle whole milliseconds, scroll a number or "bottom"', () => {
  assert.match(
    errs(inv({ rows: [row({ steps: [{ goto: 'https://x.dev/' }] })] })).join(),
    /starting with \//,
  );
  assert.match(
    errs(inv({ rows: [row({ steps: [{ settle: '1s' }] })] })).join(),
    /whole milliseconds/,
  );
  assert.match(
    errs(inv({ rows: [row({ steps: [{ scroll: 'top' }] })] })).join(),
    /"bottom"/,
  );
  assert.deepEqual(
    errs(
      inv({
        rows: [
          row({ steps: [{ goto: '/', scroll: 'bottom' }, { scroll: 400 }] }),
        ],
      }),
    ),
    [],
  );
});

test("a row's first step loads its route: rows share one page per width", () => {
  assert.match(
    errs(inv({ rows: [row({ steps: [{ click: 'button' }] })] })).join(),
    /first step loads the row's route/,
  );
});

test("a row's widths must be a non-empty subset of the run's labels", () => {
  assert.deepEqual(errs(inv({ rows: [row({ widths: ['phone'] })] })), []);
  assert.match(
    errs(inv({ rows: [row({ widths: [] })] })).join(),
    /non-empty subset/,
  );
  assert.match(
    errs(inv({ rows: [row({ widths: ['tablet'] })] })).join(),
    /non-empty subset/,
  );
});

test('row ids are unique, file-safe, and every row has a label and steps', () => {
  assert.match(errs(inv({ rows: [row(), row()] })).join(), /id used twice/);
  assert.match(errs(inv({ rows: [row({ id: '../x' })] })).join(), /lowercase/);
  assert.match(errs(inv({ rows: [row({ label: '' })] })).join(), /"label"/);
  assert.match(errs(inv({ rows: [row({ steps: [] })] })).join(), /"steps"/);
});

test('unknown top-level and row keys fail', () => {
  assert.match(
    errs(inv({ signedout: true })).join(),
    /unknown top-level key "signedout"/,
  );
  assert.match(
    errs(inv({ rows: [row({ veiw: 'a.tsx' })] })).join(),
    /unknown key "veiw"/,
  );
});

test('cookies are a list of { name, value }', () => {
  assert.deepEqual(
    errs(inv({ cookies: [{ name: 'theme', value: '${T}' }] })),
    [],
  );
  assert.match(errs(inv({ cookies: { theme: 'dark' } })).join(), /"cookies"/);
});

test('widths: each needs a lowercase label and whole sizes, labels unique', () => {
  assert.deepEqual(
    widthErrors([{ label: 'phone', width: 390, height: 844 }], 'w'),
    [],
  );
  assert.match(widthErrors([], 'w').join(), /non-empty/);
  assert.match(
    widthErrors([{ label: 'Phone', width: 390, height: 844 }], 'w').join(),
    /lowercase/,
  );
  assert.match(
    widthErrors(
      [
        { label: 'a', width: 1, height: 1 },
        { label: 'a', width: 2, height: 2 },
      ],
      'w',
    ).join(),
    /twice/,
  );
});

test('shares: every row names its view; several controls need a binding per row', () => {
  const one = { binding: 'Chassis', module: 'src/ui/chassis' };
  assert.deepEqual(
    sharesErrors(inv({ shares: one, rows: [row({ view: 'src/a.tsx' })] })),
    [],
  );
  assert.match(sharesErrors(inv({ shares: one })).join(), /names its "view"/);
  assert.match(sharesErrors(inv({ shares: [] })).join(), /empty array/);
  const two = [one, { binding: 'Sheet', module: 'src/ui/sheet' }];
  assert.match(
    sharesErrors(
      inv({ shares: two, rows: [row({ view: 'src/a.tsx' })] }),
    ).join(),
    /names one in "binding"/,
  );
  assert.deepEqual(
    sharesErrors(
      inv({
        shares: two,
        rows: [row({ view: 'src/a.tsx', binding: 'Sheet' })],
      }),
    ),
    [],
  );
  assert.match(
    sharesErrors(
      inv({ shares: [one, one], rows: [row({ view: 'v' })] }),
    ).join(),
    /twice/,
  );
});

test('expand reads the environment and throws on a missing variable', () => {
  assert.equal(expand('/decks/${ID}', 'goto', { ID: '42' }), '/decks/42');
  assert.throws(() => expand('/decks/${ID}', 'goto', {}), /needs ID/);
});

test('expand escapes a value for a regex, leaving the pattern around it alone', () => {
  const pattern = expand(
    '^${CARD}$',
    'clickRole',
    { CARD: '+2 Mace?' },
    { forRegex: true },
  );
  assert.ok(new RegExp(pattern).test('+2 Mace?'));
  assert.ok(!new RegExp(pattern).test('+2 Mac'));
});

test('the base URL: the local dev server before the PR, staging or a preview after merge', () => {
  for (const ok of [
    'http://localhost:3000',
    'http://localhost:5173/',
    'https://localhost:3000',
    'http://127.0.0.1:3000',
    'http://[::1]:3000',
    'http://LOCALHOST.:3000',
    'https://staging.example.com',
    'https://staging.example.com/',
    'https://app-git-feature.example.vercel.app',
  ])
    assert.equal(baseUrlError(ok), null, ok);
});

test('the base URL: a remote origin must be https, and an origin only', () => {
  assert.match(baseUrlError('http://staging.example.com'), /not https/);
  assert.match(baseUrlError('http://192.168.1.4:3000'), /not https/);
  assert.match(
    baseUrlError('https://staging.example.com/decks'),
    /origin only/,
  );
  assert.match(baseUrlError('http://localhost:3000/decks'), /origin only/);
  assert.match(baseUrlError('nope'), /not a URL/);
});

test('the base URL: the configured production origin is refused, nothing else is', () => {
  const productionUrl = 'https://app.example.com';
  assert.match(
    baseUrlError('https://app.example.com', { productionUrl }),
    /is production/,
  );
  assert.match(
    baseUrlError('https://APP.example.com.', { productionUrl }),
    /is production/,
  );
  assert.equal(
    baseUrlError('https://staging.example.com', { productionUrl }),
    null,
  );
  assert.equal(baseUrlError('http://localhost:3000', { productionUrl }), null);
  assert.match(
    baseUrlError('https://x.dev', { productionUrl: 'nope' }),
    /productionUrl is not a URL/,
  );
});

test('the sheet escapes labels and notes, and marks a cell with no screenshot', () => {
  const html = sheetHtml('<Feat>', [
    { label: '<b>x</b>', size: 'phone', note: 'Timeout "waiting"', data: null },
    { label: 'y', size: 'desktop', note: '', data: 'AAAA' },
  ]);
  assert.ok(!html.includes('<b>x</b>'));
  assert.ok(html.includes('&#60;Feat&#62;'));
  assert.ok(html.includes('no screenshot'));
  assert.ok(html.includes('data:image/png;base64,AAAA'));
});
