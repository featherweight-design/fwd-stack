// node --test check-shared.test.mjs
// Each case is a way of answering "shared" when the route renders its own copy: the failure this
// check exists to catch, one level up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import {
  importsSharedBinding,
  resolveSpecifier,
  sharedPairs,
  toPosix,
} from './check-shared.mjs';

const FILE = 'src/views/projects-view.tsx';
const MODULE = 'src/ui/toolbar';
const ALIASES = { '@/': 'src/' };
const ask = (source, file = FILE) =>
  importsSharedBinding(ts, {
    source,
    file,
    module: MODULE,
    binding: 'Toolbar',
    aliases: ALIASES,
  });
const IMP = 'import { Toolbar } from "../ui/toolbar";';
const USE = '\nexport const View = () => <Toolbar />;';

test('resolveSpecifier: relative, aliased, package, extension and index', () => {
  assert.equal(resolveSpecifier(FILE, '../ui/toolbar'), MODULE);
  assert.equal(resolveSpecifier(FILE, '@/ui/toolbar', ALIASES), MODULE);
  assert.equal(resolveSpecifier(FILE, '@/ui/toolbar'), null);
  assert.equal(resolveSpecifier(FILE, 'react', ALIASES), null);
  assert.equal(resolveSpecifier(FILE, '../ui/toolbar.tsx'), MODULE);
  assert.equal(resolveSpecifier(FILE, '../ui/toolbar/index'), MODULE);
  // A different module whose path ends in the same words.
  assert.notEqual(resolveSpecifier(FILE, '../../lib/copy/toolbar'), MODULE);
  // The longest alias wins.
  assert.equal(
    resolveSpecifier(FILE, '@/ui/x', { '@/': 'src/', '@/ui/': 'packages/ui/' }),
    'packages/ui/x',
  );
  assert.equal(toPosix('src\\ui\\toolbar'), MODULE);
});

test('accepts the binding imported and used, among other names, over several lines', () => {
  assert.equal(ask(IMP + USE), true);
  assert.equal(
    ask('import {\n  TOOLBAR_MIN,\n  Toolbar,\n} from "../ui/toolbar";' + USE),
    true,
  );
  assert.equal(ask('import { Toolbar } from "@/ui/toolbar";' + USE), true);
  assert.equal(ask(IMP + '\nconst C = Toolbar;'), true);
  assert.equal(ask(IMP + '\nexport const o = { Toolbar };'), true);
});

test('rejects an import that is never used', () => {
  assert.equal(ask(IMP), false);
});

test('a property key, a property access or a shadowing name is not a use', () => {
  assert.equal(ask(IMP + '\nexport const o = { Toolbar: true };'), false);
  assert.equal(ask(IMP + '\nexport const v = theme.Toolbar;'), false);
  assert.equal(
    ask(IMP + '\nexport function render(Toolbar) { return null; }'),
    false,
  );
});

test('a re-export, a JSX attribute name or a member name is not a use', () => {
  assert.equal(ask(IMP + '\nexport { Toolbar };'), false);
  assert.equal(
    ask(IMP + '\nexport const V = () => <Box Toolbar="a" />;'),
    false,
  );
  assert.equal(
    ask(IMP + '\nexport const o = { Toolbar() { return 1; } };'),
    false,
  );
  assert.equal(ask(IMP + '\nexport class C { Toolbar = 1; }'), false);
  // As a JSX attribute VALUE it is a use.
  assert.equal(
    ask(IMP + '\nexport const V = () => <Box slot={Toolbar} />;'),
    true,
  );
});

test('rejects a default import in both spellings, still sees a named one beside it', () => {
  assert.equal(ask('import Toolbar from "../ui/toolbar";' + USE), false);
  assert.equal(
    ask('import { default as Toolbar } from "../ui/toolbar";' + USE),
    false,
  );
  assert.equal(
    ask('import Other, { Toolbar } from "../ui/toolbar";' + USE),
    true,
  );
});

test('rejects an import in a comment, a template literal or a string', () => {
  assert.equal(ask('// ' + IMP + USE), false);
  assert.equal(ask('/*\n' + IMP + '\n*/' + USE), false);
  assert.equal(ask('const s = `\n' + IMP + '\n`;' + USE), false);
  assert.equal(ask("const s = '" + IMP.replace(/;$/, '') + "';" + USE), false);
});

test('rejects constant-only, type-only, other-module and longer-name imports', () => {
  assert.equal(
    ask('import { TOOLBAR_MIN } from "../ui/toolbar";' + USE),
    false,
  );
  assert.equal(
    ask('import type { Toolbar } from "../ui/toolbar";\ntype T = Toolbar;'),
    false,
  );
  assert.equal(
    ask('import { type Toolbar } from "../ui/toolbar";\ntype T = Toolbar;'),
    false,
  );
  assert.equal(
    ask('import { Toolbar } from "../../lib/toolbar";' + USE),
    false,
  );
  assert.equal(
    ask(
      'import { ToolbarCopy } from "../ui/toolbar";\nexport const V = () => <ToolbarCopy />;',
    ),
    false,
  );
});

test('follows the exported name through an alias, in both directions', () => {
  assert.equal(
    ask(
      'import { Toolbar as Bar } from "../ui/toolbar";\nexport const V = () => <Bar />;',
    ),
    true,
  );
  assert.equal(
    ask('import { Other as Toolbar } from "../ui/toolbar";' + USE),
    false,
  );
});

test('a side-effect import does not run on into a later re-export', () => {
  assert.equal(
    ask('import "./setup";\n\nexport { Toolbar } from "../ui/toolbar";' + USE),
    false,
  );
});

test('rejects a namespace import, whatever it is bound to', () => {
  assert.equal(
    ask(
      'import * as Ns from "../ui/toolbar";\nexport const V = () => <Ns.Toolbar />;',
    ),
    false,
  );
  assert.equal(ask('import * as Toolbar from "../ui/toolbar";' + USE), false);
});

test('a binding loaded on demand counts only in the one exact shape, and only when used', () => {
  const lazy = (prop, from = '../ui/toolbar') =>
    `const Toolbar = onDemand(() => import("${from}").then((m) => m.${prop}));`;
  assert.equal(ask(lazy('Toolbar') + USE), true);
  assert.equal(ask(lazy('Toolbar')), false);
  assert.equal(ask(lazy('TOOLBAR_MIN') + USE), false);
  assert.equal(ask(lazy('Toolbar', '../../lib/toolbar') + USE), false);
});

test('sharedPairs: one view checked once per control', () => {
  const one = { binding: 'Toolbar', module: MODULE };
  const rows = [
    { id: 'a', view: 'v1.tsx' },
    { id: 'b', view: 'v1.tsx' },
    { id: 'c', view: 'v2.tsx' },
  ];
  assert.deepEqual(
    sharedPairs({ shares: one, rows }).map((p) => p.view),
    ['v1.tsx', 'v2.tsx'],
  );
  const two = [one, { binding: 'Sheet', module: 'src/ui/sheet' }];
  const pairs = sharedPairs({
    shares: two,
    rows: [
      { view: 'v1.tsx', binding: 'Toolbar' },
      { view: 'v1.tsx', binding: 'Sheet' },
    ],
  });
  assert.deepEqual(
    pairs.map((p) => `${p.view}:${p.binding}:${p.module}`),
    ['v1.tsx:Toolbar:src/ui/toolbar', 'v1.tsx:Sheet:src/ui/sheet'],
  );
});

// The CLI against a throwaway project: exit 0 when shared, 1 when a view has its own copy, 2 when
// the project is not set up. TypeScript is linked in from the kit's own install.
const CLI = fileURLToPath(new URL('./check-shared.mjs', import.meta.url));
function project({
  config = { featureAcceptance: { aliases: ALIASES } },
  files = {},
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'fwd-shared-'));
  const write = (rel, text) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  write('package.json', '{}');
  if (config) write('.claude/fwd.json', JSON.stringify(config));
  const tsDir = path.dirname(
    createRequire(import.meta.url).resolve('typescript/package.json'),
  );
  mkdirSync(path.join(root, 'node_modules'));
  symlinkSync(tsDir, path.join(root, 'node_modules', 'typescript'));
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  return root;
}
const run = (root, inventory) => {
  writeFileSync(path.join(root, 'inv.json'), JSON.stringify(inventory));
  return spawnSync(
    process.execPath,
    [CLI, path.join(root, 'inv.json'), '--root', root],
    {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: root },
    },
  );
};
const INV = {
  feature: 'Toolbar',
  shares: { binding: 'Toolbar', module: 'src/ui/toolbar' },
  rows: [
    { id: 'a', label: 'a', view: 'src/views/a.tsx', steps: [{ goto: '/a' }] },
    { id: 'b', label: 'b', view: 'src/views/b.tsx', steps: [{ goto: '/b' }] },
  ],
};

test('CLI: passes when every view shares, fails naming the view that does not', () => {
  const root = project({
    files: {
      'src/ui/toolbar.tsx': 'export const Toolbar = () => null;',
      'src/views/a.tsx': 'import { Toolbar } from "@/ui/toolbar";' + USE,
      'src/views/b.tsx': 'const Toolbar = () => null;' + USE,
    },
  });
  const r = run(root, INV);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /src\/views\/b\.tsx: does not import and use Toolbar/);
  assert.doesNotMatch(r.stderr, /views\/a\.tsx/);
  // b.tsx's relative import resolves from src/views to src/ui.
  writeFileSync(path.join(root, 'src/views/b.tsx'), IMP + USE);
  assert.equal(run(root, INV).status, 0);
});

test('CLI: a missing view or shared module is named, not reported as "does not import"', () => {
  const root = project({ files: { 'src/views/a.tsx': IMP + USE } });
  const r = run(root, INV);
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /src\/ui\/toolbar is named in "shares" but does not exist/,
  );
  assert.match(
    r.stderr,
    /src\/views\/b\.tsx is named in the rows but does not exist/,
  );
});

test('CLI: no featureAcceptance block is a setup failure, exit 2', () => {
  const r = run(project({ config: null }), INV);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no "featureAcceptance" block/);
});

test('CLI: a malformed inventory fails even without shares; a typo is not "nothing to check"', () => {
  const typo = { ...INV, share: INV.shares };
  delete typo.shares;
  const r = run(project(), typo);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown top-level key "share"/);
});

test('CLI: an inventory with no shares block has nothing to check', () => {
  const noShares = { ...INV };
  delete noShares.shares;
  const r = run(project(), noShares);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no "shares" block/);
});
