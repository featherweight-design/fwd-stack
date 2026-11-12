// node --test inventory.test.mjs
// Every rule here guards a quiet pass: an inventory the contact sheet would run, photograph
// nothing or the wrong thing, and still exit 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  addSecret,
  baseUrlError,
  expand,
  inventoryErrors,
  redact,
  registerSecretEnv,
  registerSecrets,
  sharesErrors,
  sheetHtml,
  themeErrors,
  widthErrors,
} from './inventory.mjs';

const LABELS = ['phone', 'desktop'];
const row = (over = {}) => ({
  id: 'home',
  label: '/ home',
  steps: [{ goto: '/', wait: '[data-testid="home"]' }],
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

test('the base URL: a remote origin must be https; every base is an http(s) origin only', () => {
  assert.match(baseUrlError('http://staging.example.com'), /not https/);
  assert.match(baseUrlError('http://192.168.1.4:3000'), /not https/);
  assert.match(
    baseUrlError('https://staging.example.com/decks'),
    /origin only/,
  );
  assert.match(baseUrlError('http://localhost:3000/decks'), /origin only/);
  assert.match(baseUrlError('nope'), /not a URL/);
  // A name that starts with 127 is not loopback: plaintext to it would leave the machine.
  assert.match(baseUrlError('http://127.example.com'), /not https/);
  assert.match(baseUrlError('http://127.0.0.1.evil.example'), /not https/);
  assert.match(baseUrlError('ws://localhost:3000'), /http or https/);
  assert.equal(baseUrlError('http://[::ffff:127.0.0.1]:3000'), null);
});

test('the base URL: every configured production origin is refused', () => {
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
  assert.match(
    baseUrlError('https://x.dev', { productionUrl: '' }),
    /omit it rather/,
  );
  assert.match(
    baseUrlError('https://x.dev', { productionUrl: [] }),
    /omit it rather/,
  );
  // Every alias is listed, and each is refused; a different port is a different origin.
  const aliases = ['https://app.example.com', 'https://www.app.example.com'];
  assert.match(
    baseUrlError('https://www.app.example.com', { productionUrl: aliases }),
    /is production/,
  );
  assert.equal(
    baseUrlError('https://app.example.com:8443', { productionUrl: aliases }),
    null,
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

// A fake invite token: never a real one. Each test uses its own value, since the registry is
// process-wide.
const FAKE = 'fake-INVITE-tok3n/with+chars?&=';

test('redact: an expanded value is scrubbed as typed, URL-encoded, regex-escaped and JSON-escaped', () => {
  const env = { CC_CREW_INVITE_TOKEN: FAKE };
  const url = expand('/invite/${CC_CREW_INVITE_TOKEN}', 'goto', env);
  const pattern = expand('^${CC_CREW_INVITE_TOKEN}$', 'name', env, {
    forRegex: true,
  });
  for (const leak of [
    `page.goto: Timeout navigating to "https://x.test${url}"`,
    `landed on /invite/${encodeURIComponent(FAKE)}`,
    // As Playwright prints it: a RegExp's source escapes the token's `/` as `\/`.
    `waiting for getByRole('button', { name: ${String(new RegExp(pattern))} })`,
    JSON.stringify({ token: FAKE }),
  ]) {
    const out = redact(leak);
    assert.ok(!out.includes('INVITE-tok3n'), out);
    assert.match(out, /\[redacted CC_CREW_INVITE_TOKEN\]/);
  }
});

test('registerSecrets: every ${VAR} anywhere in the inventory is scrubbed before any step expands it', () => {
  const env = { DECK_SECRET: 'fake-deck-0042x', UNUSED: 'never-mentioned' };
  registerSecrets(
    inv({
      cookies: [{ name: 'k', value: 'a${DECK_SECRET}' }],
      rows: [row({ steps: [{ goto: '/d/${MISSING}' }] })],
    }),
    env,
  );
  assert.equal(redact('err fake-deck-0042x'), 'err [redacted DECK_SECRET]');
  // Only named variables are secrets, and a missing one registers nothing.
  assert.equal(redact('never-mentioned'), 'never-mentioned');
});

test('redact: the longer of two overlapping secrets is replaced whole', () => {
  addSecret('SHORT', 'fake-abc');
  addSecret('LONG', 'fake-abc-def');
  assert.equal(
    redact('fake-abc-def fake-abc'),
    '[redacted LONG] [redacted SHORT]',
  );
});

test('the sheet redacts every text on it', () => {
  addSecret('SHEET_TOKEN', 'fake-sheet-9f8e7d');
  const html = sheetHtml('Invites', [
    {
      label: 'invite',
      size: 'phone',
      note: 'goto /invite/${X} landed on /invite/fake-sheet-9f8e7d/',
      data: null,
    },
  ]);
  assert.ok(!html.includes('fake-sheet-9f8e7d'));
  assert.match(html, /redacted SHEET_TOKEN/);
});

test('themes: label, a way to select the theme, and known keys only', () => {
  assert.deepEqual(
    themeErrors(
      [
        {
          label: 'light',
          storage: { 'cc-theme': 'light' },
          dataTheme: 'light',
        },
        { label: 'electric', colorScheme: 'dark', dataTheme: 'electric' },
        {
          label: 'jade',
          cookies: [{ name: 'theme', value: 'jade' }],
          dataTheme: 'jade',
        },
      ],
      'inventory',
    ),
    [],
  );
  assert.match(themeErrors([], 'x').join(), /non-empty/);
  assert.match(
    themeErrors([{ label: 'Dark', colorScheme: 'dark' }], 'x').join(),
    /lowercase/,
  );
  assert.match(
    themeErrors([{ label: 'dark' }], 'x').join(),
    /draws the default/,
  );
  assert.match(
    themeErrors(
      [
        { label: 'a', colorScheme: 'dark' },
        { label: 'a', colorScheme: 'dark' },
      ],
      'x',
    ).join(),
    /twice/,
  );
  const bad = themeErrors(
    [
      {
        label: 'a',
        colorScheme: 'dim',
        storage: { k: 1 },
        cookies: [{ name: 'x' }],
        dataTheme: '',
        colour: 'x',
      },
    ],
    'x',
  ).join();
  for (const m of [
    /colorScheme/,
    /storage/,
    /cookies/,
    /dataTheme/,
    /unknown key "colour"/,
  ])
    assert.match(bad, m);
  assert.deepEqual(
    errs(
      inv({ themes: [{ label: 'a', colorScheme: 'dark', dataTheme: 'a' }] }),
    ),
    [],
  );
  assert.match(
    errs(inv({ themes: [{ label: 'a' }] })).join(),
    /draws the default/,
  );
});

test('goto: expectStatus is an HTTP status, expectRedirect a path; neither without goto', () => {
  const step = (s) => errs(inv({ rows: [row({ steps: [s] })] })).join();
  assert.equal(
    step({ goto: '/nope', expectStatus: 404, wait: '[data-testid="home"]' }),
    '',
  );
  assert.equal(step({ goto: '/app', expectRedirect: '/sign-in' }), '');
  assert.match(step({ goto: '/nope', expectStatus: '404' }), /expectStatus/);
  assert.match(step({ goto: '/nope', expectStatus: 302 }), /expectStatus/);
  assert.match(
    step({ goto: '/app', expectRedirect: 'sign-in' }),
    /expectRedirect/,
  );
  assert.match(
    errs(
      inv({
        rows: [
          row({
            steps: [
              { goto: '/' },
              { wait: '[data-testid="home"]', expectStatus: 404 },
            ],
          }),
        ],
      }),
    ).join(),
    /"expectStatus" belongs with "goto"/,
  );
});

test('route: a glob with a status, a body or both; it may come before the goto', () => {
  const steps = (s) => errs(inv({ rows: [row({ steps: s })] })).join();
  assert.equal(
    steps([
      { route: '**/api/feed', status: 500 },
      { goto: '/', wait: '[data-testid="home"]' },
    ]),
    '',
  );
  assert.equal(
    steps([{ route: '**/api/feed', body: { items: [] }, goto: '/' }]),
    '',
  );
  assert.match(steps([{ route: '**/api/x' }, { goto: '/' }]), /answers with/);
  assert.match(
    steps([{ route: '', status: 200 }, { goto: '/' }]),
    /"route" takes a non-empty/,
  );
  assert.match(
    steps([{ route: '**/x', status: 99 }, { goto: '/' }]),
    /"status" is an HTTP status/,
  );
  assert.match(
    steps([{ goto: '/', status: 200 }]),
    /"status" belongs with "route"/,
  );
  // A route first does not excuse the row from loading its own route.
  assert.match(
    steps([{ route: '**/x', status: 204 }, { wait: '[data-testid="home"]' }]),
    /first step loads/,
  );
});

test('waitDialog and clickRole name are regexes, and an invalid one fails before a run', () => {
  const steps = (s) =>
    errs(inv({ rows: [row({ steps: [{ goto: '/' }, s] })] })).join();
  assert.equal(steps({ waitDialog: '^Filters$' }), '');
  assert.equal(steps({ waitDialog: 'Invite ${NAME}' }), '');
  assert.match(
    steps({ waitDialog: 'Filters (' }),
    /"waitDialog" is not a valid regex/,
  );
  assert.match(
    steps({ clickRole: 'button', name: '[' }),
    /"name" is not a valid regex/,
  );
});

test('themes: dataTheme is required, and theme values are literal', () => {
  assert.match(
    themeErrors(
      [{ label: 'jade', cookies: [{ name: 't', value: 'jade' }] }],
      'x',
    ).join(),
    /dataTheme/,
  );
  assert.match(
    themeErrors(
      [{ label: 'jade', storage: { t: '${THEME}' }, dataTheme: 'jade' }],
      'x',
    ).join(),
    /literal/,
  );
});

test('goto: a 3xx is never a final status, so expectStatus refuses it', () => {
  const step = (s) => errs(inv({ rows: [row({ steps: [s] })] })).join();
  assert.match(step({ goto: '/a', expectStatus: 301 }), /expectStatus/);
  assert.equal(step({ goto: '/a', expectStatus: 200 }), '');
  assert.equal(step({ goto: '/a', expectStatus: 503 }), '');
});

test('clickRole: an empty name would match every element of the role, so it fails', () => {
  const e = errs(
    inv({
      rows: [
        row({ steps: [{ goto: '/' }, { clickRole: 'button', name: '' }] }),
      ],
    }),
  );
  assert.match(e.join(), /"name" takes a non-empty pattern/);
});

test('expand forPath: a value that would change the query or fragment throws, naming only the variable', () => {
  assert.equal(
    expand('/i/${T}', 'goto', { T: 'fake-ok_1' }, { forPath: true }),
    '/i/fake-ok_1',
  );
  for (const bad of ['fake?x=1', 'fake#frag', 'fake tok', 'fake\\x'])
    assert.throws(
      () => expand('/i/${T}', 'goto', { T: bad }, { forPath: true }),
      (e) => /T holds a \?/.test(e.message) && !e.message.includes(bad),
    );
});

test('registerSecretEnv: a credential-named variable is scrubbed though no inventory names it', () => {
  registerSecretEnv({
    CC_SESSION_COOKIE: 'fake-ck-271828',
    CC_API_KEY: 'fake-key-161803',
    NODE_ENV: 'development',
    SHORT_TOKEN: '1',
  });
  assert.equal(
    redact('bad login fake-ck-271828 with fake-key-161803'),
    'bad login [redacted CC_SESSION_COOKIE] with [redacted CC_API_KEY]',
  );
  // Not a credential by name, or too short to scrub from every line.
  assert.equal(redact('development 1 of 3'), 'development 1 of 3');
});

test('a wait on a bare element is refused: the loading skeleton draws it too', () => {
  for (const wait of ['h1', 'main', ' table ', 'header'])
    assert.match(
      errs(inv({ rows: [row({ steps: [{ goto: '/', wait }] })] })).join(),
      /passes on a loading skeleton/,
    );
  for (const wait of [
    '[data-testid="show-list"]',
    'main h2',
    'h1:has-text("Shows")',
    'role=heading[name="Shows"]',
    'text=No results',
  ])
    assert.deepEqual(
      errs(inv({ rows: [row({ steps: [{ goto: '/', wait }] })] })),
      [],
    );
});

test('expectMeta needs a content pattern that compiles and is not empty', () => {
  const steps = (s) => errs(inv({ rows: [row({ steps: s })] })).join();
  assert.equal(
    steps([
      { goto: '/x', expectStatus: 404 },
      { expectMeta: 'robots', content: 'noindex' },
    ]),
    '',
  );
  assert.match(
    steps([{ expectMeta: 'robots' }]),
    /"expectMeta" needs "content"/,
  );
  assert.match(
    steps([{ expectMeta: 'robots', content: '' }]),
    /non-empty pattern/,
  );
  assert.match(
    steps([{ expectMeta: 'robots', content: '(' }]),
    /not a valid regex/,
  );
  assert.match(steps([{ expectMeta: '', content: 'x' }]), /non-empty string/);
  assert.match(steps([{ expectMeta: 'robots', content: '${X}' }]), /takes no/);
});
