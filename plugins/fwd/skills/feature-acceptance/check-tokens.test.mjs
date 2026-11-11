// node --test check-tokens.test.mjs
// Every failure mode of this parser is a SILENT PASS (the check reads nothing and says clean), the
// same hazard as the bug it catches, so each shape that could defeat it is pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  declarationsIn,
  filesMatching,
  hexColours,
  undeclaredIn,
  usedTokens,
} from './check-tokens.mjs';

test('usedTokens: a plain read counts; a read with a fallback does not', () => {
  assert.deepEqual(usedTokens('color: var(--fg-muted);'), ['--fg-muted']);
  assert.deepEqual(
    usedTokens('animation: bob var(--bob-duration, 3s) linear;'),
    [],
  );
  assert.deepEqual(usedTokens('color: var(--fg, #fff);'), []);
});

test('usedTokens: a var() nested in a fallback is load-bearing', () => {
  assert.deepEqual(usedTokens('color: var(--primary, var(--fallback));'), [
    '--fallback',
  ]);
});

test('usedTokens: nothing out of a comment, but a URL is not a comment', () => {
  assert.deepEqual(usedTokens('// var(--does-not-exist)\ncolor: var(--fg);'), [
    '--fg',
  ]);
  assert.deepEqual(usedTokens('/* var(--gone) */'), []);
  assert.deepEqual(
    usedTokens('background: url(https://x.dev/a.png) var(--bg);'),
    ['--bg'],
  );
});

test('usedTokens: both branches of an interpolation; nothing it cannot resolve', () => {
  const source = '`1px solid var(--${inert ? "border" : "border-strong"})`';
  assert.deepEqual(usedTokens(source).sort(), ['--border', '--border-strong']);
  assert.deepEqual(usedTokens('`var(--fg-${tone})`'), []);
  assert.deepEqual(usedTokens('`var(--${compute()})`'), []);
});

test('usedTokens and declarationsIn: underscores are part of the name', () => {
  // `var(--surface_2)` read as `--surface` would pass whenever `--surface` exists.
  assert.deepEqual(usedTokens('color: var(--surface_2);'), ['--surface_2']);
  assert.ok(declarationsIn('--my_x: 1;').has('--my_x'));
  assert.deepEqual(
    undeclaredIn(
      [{ path: 'a.tsx', source: 'var(--surface_2)' }],
      ['--surface: #000;'],
    ),
    [{ file: 'a.tsx', token: '--surface_2' }],
  );
});

test('declarationsIn: a BEM modifier before a colon is a class, not a declaration', () => {
  assert.deepEqual(
    [...declarationsIn('.btn--primary:hover { color: red; }')],
    [],
  );
  assert.deepEqual(
    [...declarationsIn('const c = { "card--active": true };')],
    [],
  );
});

test('a // inside a string or URL is not a comment', () => {
  const source =
    '<img src="//cdn.x/a.png" style={{ background: "var(--ghost)" }} />';
  assert.deepEqual(usedTokens(source), ['--ghost']);
  assert.deepEqual(
    usedTokens('a { background: url(//cdn.x/a.png) var(--bg); }'),
    ['--bg'],
  );
  assert.deepEqual(
    hexColours('<img src="//cdn.x/a.png" style={{ color: "#ff0000" }} />').map(
      (h) => h.hex,
    ),
    ['#ff0000'],
  );
});

test('declarationsIn: CSS, quoted style keys and next/font variables; not comments', () => {
  assert.ok(declarationsIn('--fg: #fff;').has('--fg'));
  assert.ok(declarationsIn('{ "--row-bg": "var(--surface)" }').has('--row-bg'));
  assert.ok(declarationsIn('{ variable: "--font-mono" }').has('--font-mono'));
  assert.deepEqual(
    [...declarationsIn('// --ghost: old name\nconst a = 1;')],
    [],
  );
  assert.deepEqual([...declarationsIn('/* --ghost-block: gone */')], []);
});

const GLOBAL = ['--fg: #fff; --surface: #000;'];

test('undeclaredIn: reports a token nothing declares', () => {
  assert.deepEqual(
    undeclaredIn([{ path: 'a.tsx', source: 'var(--surface-2)' }], GLOBAL),
    [{ file: 'a.tsx', token: '--surface-2' }],
  );
});

test("undeclaredIn: a file's own declaration covers it, and no other file", () => {
  const own =
    '<div style={{ "--row-bg": "red" }}><i c="var(--row-bg)" /></div>';
  assert.deepEqual(
    undeclaredIn([{ path: 'row.tsx', source: own }], GLOBAL),
    [],
  );
  const files = [
    { path: 'row.tsx', source: '{ "--row-bg": "red" }' },
    { path: 'other.tsx', source: 'var(--row-bg)' },
  ];
  assert.deepEqual(undeclaredIn(files, GLOBAL), [
    { file: 'other.tsx', token: '--row-bg' },
  ]);
});

test("undeclaredIn: a stylesheet may resolve against a component's token, and keeps its own typos", () => {
  const files = [
    { path: 'art.tsx', source: '{ "--wash-opacity": 0.3 }' },
    {
      path: 'app.css',
      source: '.wash { opacity: var(--wash-opacity); color: var(--fgg); }',
    },
  ];
  assert.deepEqual(undeclaredIn(files, GLOBAL, new Set(['app.css'])), [
    { file: 'app.css', token: '--fgg' },
  ]);
});

test('hexColours: 3, 4, 6 and 8 digits, with line numbers', () => {
  const found = hexColours(
    'a {\n  color: #fff;\n  background: #1a2b3c80;\n}\n<i fill="#0a0b" />',
  );
  assert.deepEqual(found, [
    { line: 2, hex: '#fff' },
    { line: 3, hex: '#1a2b3c80' },
    { line: 5, hex: '#0a0b' },
  ]);
  assert.deepEqual(
    hexColours('className="bg-[#123456] text-[#abc]"').map((h) => h.hex),
    ['#123456', '#abc'],
  );
});

test('hexColours: not 5 or 7 digits, not an entity or a word, not in a comment, not on an allowed line', () => {
  assert.deepEqual(hexColours('#12345 #1234567 &#123; a#fff #fffg #fff-x'), []);
  assert.deepEqual(hexColours('// #fff\n/* #000\n#111 */\nconst a = 1;'), []);
  assert.deepEqual(
    hexColours('fill: "#1DA1F2", // fwd-allow-hex: brand mark'),
    [],
  );
  // A URL's `//` is not a comment.
  assert.deepEqual(
    hexColours('background: url(https://x.dev/#a.png) #000;').map((h) => h.hex),
    ['#000'],
  );
});

function project(config, files) {
  const root = mkdtempSync(path.join(tmpdir(), 'fwd-tokens-'));
  const write = (rel, text) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  if (config)
    write('.claude/fwd.json', JSON.stringify({ featureAcceptance: config }));
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  return root;
}
const CLI = fileURLToPath(new URL('./check-tokens.mjs', import.meta.url));
const run = (root, ...args) =>
  spawnSync(process.execPath, [CLI, '--root', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: root },
  });
const TOKENS = {
  tokens: {
    declare: ['src/theme.css'],
    read: ['src/**/*.{tsx,css}'],
    hex: ['src/components/**/*.tsx'],
  },
};

test('filesMatching: globs, test files and node_modules out', async () => {
  const root = project(null, {
    'src/a.tsx': '',
    'src/a.test.tsx': '',
    'src/__tests__/b.tsx': '',
    'src/node_modules/c.tsx': '',
  });
  assert.deepEqual(await filesMatching(root, ['src/**/*.tsx']), ['src/a.tsx']);
});

test('CLI: clean exits 0; an undeclared read exits 1 naming file and token', () => {
  const files = {
    'src/theme.css': ':root { --fg: black; }',
    'src/components/a.tsx': 'const c = "var(--fg)";',
  };
  assert.equal(run(project(TOKENS, files)).status, 0);
  const bad = run(
    project(TOKENS, {
      ...files,
      'src/components/b.tsx': 'x = "var(--surface-2)"',
    }),
  );
  assert.equal(bad.status, 1);
  assert.match(
    bad.stderr,
    /src\/components\/b\.tsx reads --surface-2, which nothing declares/,
  );
});

test('CLI: a hex colour is reported and passes, unless hexFails or --strict-hex', () => {
  const files = {
    'src/theme.css': ':root { --fg: #000; }',
    'src/components/a.tsx': 'const s = { color: "#ff0000" };',
  };
  const soft = run(project(TOKENS, files));
  assert.equal(soft.status, 0);
  assert.match(soft.stdout, /src\/components\/a\.tsx:1 hard-codes #ff0000/);
  assert.equal(run(project(TOKENS, files), '--strict-hex').status, 1);
  assert.equal(
    run(project({ tokens: { ...TOKENS.tokens, hexFails: true } }, files))
      .status,
    1,
  );
});

test('CLI: an unknown flag is a setup failure, not a soft pass', () => {
  const r = run(
    project(TOKENS, { 'src/theme.css': ':root { --fg: #000; }' }),
    '--strict-hx',
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown flag --strict-hx/);
});

test('CLI: missing config, or globs matching nothing, is a setup failure, exit 2', () => {
  const none = run(project(null, {}));
  assert.equal(none.status, 2);
  assert.match(none.stderr, /no "featureAcceptance" block/);
  const noDeclare = run(project({ tokens: { read: ['src/**/*.tsx'] } }, {}));
  assert.equal(noDeclare.status, 2);
  assert.match(noDeclare.stderr, /tokens\.declare is not set/);
  const empty = run(project(TOKENS, {}));
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /matches no file/);
});
