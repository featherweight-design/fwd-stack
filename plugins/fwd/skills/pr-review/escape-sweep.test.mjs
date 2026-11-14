// node --test escape-sweep.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  escapedFrom,
  formatReport,
  isFixTitle,
  missingSources,
  overlapIgnored,
  parseArgs,
  riskOf,
  sweepRepo,
  truncate,
} from './escape-sweep.mjs';
import { NOT_RISKY_TITLE, riskyPathsOf } from './risk-override.mjs';

const pr = (number, mergedAt, title, files, body = '') => ({
  number,
  title,
  body,
  files,
  mergedAt,
});

test('parseArgs reads repeated repos, the date and --json', () => {
  assert.deepEqual(
    parseArgs([
      '--repo',
      'a/b',
      '--repo',
      'c/d',
      '--since',
      '2026-11-07',
      '--json',
    ]),
    { repos: ['a/b', 'c/d'], since: '2026-11-07', json: true },
  );
});

test('parseArgs refuses a missing repo, a bad date and unknown flags', () => {
  assert.throws(
    () => parseArgs(['--since', '2026-11-07']),
    /--repo is required/,
  );
  assert.throws(() => parseArgs(['--repo', 'a/b']), /--since/);
  assert.throws(
    () => parseArgs(['--repo', 'a/b', '--since', '11/07']),
    /--since/,
  );
  assert.throws(
    () => parseArgs(['--repo', 'nope', '--since', '2026-11-07']),
    /owner\/name/,
  );
  assert.throws(
    () => parseArgs(['--repo', 'a/b', '--since', '2026-11-07', '-x']),
    /unknown/,
  );
  assert.throws(
    () => parseArgs(['--repo', '--since', '2026-11-07']),
    /needs a value/,
  );
});

test('escapedFrom reads the heading and a bare line, once each', () => {
  assert.deepEqual(escapedFrom('Fixes it.\n\n## Escaped from #12\n'), [12]);
  assert.deepEqual(
    escapedFrom('Escaped from #7\nescaped from #7\n## Escaped from #9'),
    [7, 9],
  );
  assert.deepEqual(
    escapedFrom('This is not Escaped from #4 mid-sentence.'),
    [],
  );
  assert.deepEqual(escapedFrom(null), []);
});

test('isFixTitle takes conventional fix, revert and hotfix with any scope', () => {
  for (const t of [
    'fix: x',
    'fix(api): x',
    'Fix(db)!: x',
    'revert: x',
    'hotfix(auth): x',
    'Revert "feat: x"',
  ])
    assert.equal(isFixTitle(t), true, t);
  for (const t of [
    'feat: fix x',
    'fixture: x',
    'chore(fix): x',
    'docs: revert note',
  ])
    assert.equal(isFixTitle(t), false, t);
});

test('riskOf uses the gate path rule, never body text', () => {
  assert.equal(
    riskOf(pr(1, '', 'feat: x', ['src/app/api/users/route.ts'])).risky,
    true,
  );
  // Body words about payments or auth do not make a design-polish PR risky.
  assert.equal(
    riskOf(
      pr(
        2,
        '',
        'style: x',
        ['src/components/card.tsx'],
        'Touches auth, payments, migrations.',
      ),
    ).risky,
    false,
  );
  // Tests and docs on a risky path are not risky, the same as the gate.
  assert.equal(
    riskOf(pr(3, '', 'test: x', ['src/db/users.test.ts', 'docs/db/x.md']))
      .risky,
    false,
  );
});

test('riskOf honours a real `## Risk: not risky` declaration on a soft risky path', () => {
  const body = `${NOT_RISKY_TITLE}\n\nDisplay-only: formats a credit amount, changes no charge.\n`;
  assert.equal(
    riskOf(pr(4, '', 'feat: x', ['src/lib/credits-text.ts'], body)).risky,
    false,
  );
  // ...but not on a hard-risky path.
  assert.equal(
    riskOf(pr(5, '', 'feat: x', ['src/app/api/x/route.ts'], body)).risky,
    true,
  );
});

test('riskyPathsOf keeps a rename out of a risky path, and drops nonRuntime paths', () => {
  assert.deepEqual(
    riskyPathsOf([
      { filename: 'src/lib/x.ts', previous_filename: 'src/db/x.ts' },
    ]),
    ['src/db/x.ts'],
  );
  assert.deepEqual(
    riskyPathsOf([{ filename: 'src/db/x.ts' }], new Set(['src/db/x.ts'])),
    [],
  );
});

test('riskOf reads REST file objects: a rename out of a risky path is risky', () => {
  const renamed = {
    filename: 'src/lib/users.ts',
    previous_filename: 'src/db/users.ts',
    status: 'renamed',
  };
  assert.equal(riskOf(pr(6, '', 'refactor: move', [renamed])).risky, true);
});

test('overlapIgnored drops docs, tests, generated and handoff, and keeps config', () => {
  for (const p of [
    'README.md',
    'src/db/x.test.ts',
    'tests/e2e/login.spec.ts',
    'pnpm-lock.yaml',
    'drizzle/meta/_journal.json',
    'design/handoff/x.dc.html',
  ])
    assert.equal(overlapIgnored(p), true, p);
  for (const p of [
    'src/db/users.ts',
    'package.json',
    '.github/workflows/ci.yml',
  ])
    assert.equal(overlapIgnored(p), false, p);
});

test('missingSources names sources outside the list, once', () => {
  const prs = [
    pr(10, '2026-11-08T00:00:00Z', 'fix: a', [], '## Escaped from #3'),
    pr(
      11,
      '2026-11-08T00:00:00Z',
      'fix: b',
      [],
      'Escaped from #3\nEscaped from #10',
    ),
  ];
  assert.deepEqual(missingSources(prs), [3]);
});

const since = '2026-11-07';
const riskyDb = pr(20, '2026-11-01T10:00:00Z', 'feat(db): add column', [
  'src/db/users.ts',
  'README.md',
  'pnpm-lock.yaml',
]);
const oldRisky = pr(19, '2026-10-20T10:00:00Z', 'feat(db): old', [
  'src/db/users.ts',
]);
const polish = pr(
  21,
  '2026-11-02T10:00:00Z',
  'style: polish',
  ['src/components/card.tsx'],
  'auth payments db',
);

test('sweepRepo flags a fix touching a risky PR file within 14 days', () => {
  const fix = pr(30, '2026-11-08T10:00:00Z', 'fix(db): null users', [
    'src/db/users.ts',
    'README.md',
  ]);
  const r = sweepRepo({ prs: [oldRisky, riskyDb, polish, fix], since });
  assert.deepEqual(r.candidates, [
    {
      number: 30,
      title: 'fix(db): null users',
      sources: [{ number: 20, files: ['src/db/users.ts'] }],
    },
  ]);
  assert.equal(r.named.length, 0);
  // riskyDb landed before --since, so it is a source but not a landed risky PR; the fix itself
  // touches the DB layer, so it is the one risky PR landed.
  assert.equal(r.riskyLanded, 1);
});

test('sweepRepo ignores overlap on docs and lockfiles, non-risky sources and non-fix titles', () => {
  const docsFix = pr(31, '2026-11-08T10:00:00Z', 'fix: docs', [
    'README.md',
    'pnpm-lock.yaml',
  ]);
  const polishFix = pr(32, '2026-11-08T10:00:00Z', 'fix: card', [
    'src/components/card.tsx',
  ]);
  const feat = pr(33, '2026-11-08T10:00:00Z', 'feat(db): more', [
    'src/db/users.ts',
  ]);
  const r = sweepRepo({
    prs: [riskyDb, polish, docsFix, polishFix, feat],
    since,
  });
  assert.deepEqual(r.candidates, []);
  assert.equal(r.riskyLanded, 1); // feat #33 is itself risky and landed in the window
});

test('sweepRepo skips risky PRs older than 14 days or landed after the fix', () => {
  const fix = pr(34, '2026-11-08T10:00:00Z', 'fix: users', ['src/db/users.ts']);
  const later = pr(35, '2026-11-09T10:00:00Z', 'feat(db): later', [
    'src/db/users.ts',
  ]);
  const r = sweepRepo({ prs: [oldRisky, fix, later], since });
  assert.deepEqual(r.candidates, []);
});

test('sweepRepo reports named escapes with source risk and does not double-count them', () => {
  const fix = pr(
    36,
    '2026-11-08T10:00:00Z',
    'fix(db): users',
    ['src/db/users.ts'],
    '## Escaped from #20\nEscaped from #21\nEscaped from #5',
  );
  const extra = [pr(5, null, '', undefined)];
  delete extra[0].files;
  const r = sweepRepo({ prs: [riskyDb, polish, fix], since, extra });
  assert.deepEqual(r.named, [
    {
      number: 36,
      title: 'fix(db): users',
      sources: [
        { number: 20, risky: true },
        { number: 21, risky: false },
        { number: 5, risky: null },
      ],
    },
  ]);
  assert.deepEqual(r.candidates, []);
});

test('truncate keeps titles to 70 characters', () => {
  assert.equal(truncate('a'.repeat(70)), 'a'.repeat(70));
  const t = truncate('b'.repeat(90));
  assert.equal(t.length, 70);
  assert.ok(t.endsWith('...'));
});

test('formatReport prints a table per repo and the totals', () => {
  const fix = pr(30, '2026-11-08T10:00:00Z', 'fix(db): null users', [
    'src/db/users.ts',
  ]);
  const named = pr(
    36,
    '2026-11-09T10:00:00Z',
    'fix: other',
    [],
    '## Escaped from #20',
  );
  const result = {
    repo: 'o/r',
    ...sweepRepo({ prs: [riskyDb, fix, named], since }),
  };
  const empty = { repo: 'o/s', riskyLanded: 2, named: [], candidates: [] };
  const text = formatReport([result, empty], since);
  assert.match(text, /^Escape sweep since 2026-11-07/);
  assert.match(
    text,
    /o\/r: 1 risky PR\(s\) landed, 1 named escape\(s\), 1 candidate\(s\)/,
  );
  assert.match(text, /#36\s+fix: other\s+#20 \(risky\)\s+named escape/);
  assert.match(text, /#30\s+fix\(db\): null users\s+#20\s+src\/db\/users\.ts/);
  assert.match(text, /o\/s: [^\n]*\n\(none\)/);
  assert.match(
    text,
    /Totals: 3 risky PR\(s\) landed, 1 named escape\(s\), 1 candidate\(s\)$/,
  );
});

test('sweepRepo ignores a candidate whose only overlap is a version-only manifest bump', () => {
  const manifest = 'plugins/x/.claude-plugin/plugin.json';
  const bump = {
    filename: manifest,
    status: 'modified',
    patch:
      '@@ -2,3 +2,3 @@\n   "name": "x",\n-  "version": "1.0.0",\n+  "version": "1.0.1",\n   "author": "a"',
  };
  const risky = pr(40, '2026-11-01T10:00:00Z', 'feat(auth): x', [
    'src/auth/login.ts',
    manifest,
  ]);
  const fix = pr(41, '2026-11-08T10:00:00Z', 'fix: hook', [
    'src/hook.mjs',
    bump,
  ]);
  assert.deepEqual(sweepRepo({ prs: [risky, fix], since }).candidates, []);
  // The same manifest, changed beyond its version, does overlap.
  const real = {
    ...bump,
    patch: '@@ -1 +1 @@\n-  "hooks": "a",\n+  "hooks": "b",',
  };
  const fix2 = pr(42, '2026-11-08T10:00:00Z', 'fix: hook', [real]);
  assert.deepEqual(sweepRepo({ prs: [risky, fix2], since }).candidates, [
    {
      number: 42,
      title: 'fix: hook',
      sources: [{ number: 40, files: [manifest] }],
    },
  ]);
});
