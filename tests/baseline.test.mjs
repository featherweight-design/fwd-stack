// Feeds sample package.json files through the baseline check that .github/workflows/baseline.yml
// runs, so a project is warned about exactly the drift it has and nothing else.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { check } from '../scripts/baseline-check.mjs';

const baseline = {
  node: '24',
  nodeMinimum: '24.22.1',
  pnpm: '10.33.2',
  packages: { next: '16', zod: '4', 'drizzle-orm': '0.45', eslint: '9' },
};
const root = (json) => ({
  path: 'package.json',
  json: { packageManager: 'pnpm@10.33.2', ...json },
});
const pin = (text) => ({ path: '.nvmrc', text });
const messages = (input) =>
  check({ baseline, nodePin: pin('24.22.1\n'), ...input }).map(
    (f) => `${f.file}: ${f.message}`,
  );

test('a project on the baseline has no findings', () => {
  assert.deepEqual(
    messages({
      packages: [
        root({
          dependencies: {
            next: '^16.4.5',
            zod: '~4.1.0',
            'drizzle-orm': '0.45.2',
          },
          devDependencies: { eslint: '^9.39.5', 'left-pad': '^1.0.0' },
        }),
      ],
    }),
    [],
  );
});

test('a package the baseline does not list, or the project does not use, is skipped', () => {
  assert.deepEqual(
    messages({ packages: [root({ dependencies: { react: '^18.0.0' } })] }),
    [],
  );
});

test('a major behind or ahead is reported once per package and field', () => {
  assert.deepEqual(
    messages({
      packages: [
        root({
          dependencies: { zod: '^3.25.0' },
          devDependencies: { eslint: '^10.0.0' },
        }),
        {
          path: 'apps/web/package.json',
          json: { dependencies: { next: '15.5.0' } },
        },
      ],
    }),
    [
      'package.json: zod ^3.25.0 in dependencies; the baseline is 4',
      'package.json: eslint ^10.0.0 in devDependencies; the baseline is 9',
      'apps/web/package.json: next 15.5.0 in dependencies; the baseline is 16',
    ],
  );
});

test('a 0.x package compares major.minor', () => {
  assert.deepEqual(
    messages({
      packages: [root({ dependencies: { 'drizzle-orm': '^0.44.7' } })],
    }),
    ['package.json: drizzle-orm ^0.44.7 in dependencies; the baseline is 0.45'],
  );
});

test('a spec with no version number (workspace, catalog, git) is skipped', () => {
  assert.deepEqual(
    messages({
      packages: [
        root({
          dependencies: {
            next: 'catalog:',
            zod: 'workspace:*',
            eslint: 'github:eslint/eslint',
          },
        }),
      ],
    }),
    [],
  );
});

test('fwdBaseline.ignore in the root applies everywhere; in a package, to that package', () => {
  assert.deepEqual(
    messages({
      packages: [
        root({
          fwdBaseline: { ignore: ['zod'] },
          dependencies: { zod: '^3.0.0' },
        }),
        {
          path: 'packages/a/package.json',
          json: {
            fwdBaseline: { ignore: ['next'] },
            dependencies: { zod: '3', next: '15' },
          },
        },
        {
          path: 'packages/b/package.json',
          json: { dependencies: { next: '15' } },
        },
      ],
    }),
    ['packages/b/package.json: next 15 in dependencies; the baseline is 16'],
  );
});

test('the Node pin must be the baseline major and at least the minimum', () => {
  const run = (text) =>
    messages({
      packages: [root({})],
      nodePin: text === null ? null : pin(text),
    });
  assert.deepEqual(
    run('24\n'),
    [],
    'a major-only pin resolves to the newest 24.x',
  );
  assert.deepEqual(run('v24.23.0'), []);
  assert.deepEqual(run('24.22'), []);
  assert.deepEqual(run('24.22.0'), [
    '.nvmrc: Node 24.22.0; the baseline is Node 24, at least 24.22.1',
  ]);
  assert.deepEqual(run('24.9'), [
    '.nvmrc: Node 24.9; the baseline is Node 24, at least 24.22.1',
  ]);
  assert.deepEqual(run('26.1.0'), [
    '.nvmrc: Node 26.1.0; the baseline is Node 24, at least 24.22.1',
  ]);
  assert.deepEqual(run(null), [
    'package.json: no Node version pin (.nvmrc or .node-version) to check against 24.22.1',
  ]);
});

test('packageManager must be pnpm at the baseline major', () => {
  const run = (packageManager) =>
    messages({
      packages: [{ path: 'package.json', json: { packageManager } }],
    });
  assert.deepEqual(run('pnpm@10.12.0'), []);
  assert.deepEqual(run('pnpm@9.15.0'), [
    'package.json: packageManager pnpm@9.15.0; the baseline is pnpm 10.33.2',
  ]);
  assert.deepEqual(run('npm@11.0.0'), [
    'package.json: packageManager npm@11.0.0; the baseline is pnpm 10.33.2',
  ]);
  assert.deepEqual(run(undefined), [
    'package.json: packageManager (unset); the baseline is pnpm 10.33.2',
  ]);
});

test('"node" and "pnpm" in the root ignore list skip those checks', () => {
  assert.deepEqual(
    messages({
      packages: [
        {
          path: 'package.json',
          json: { fwdBaseline: { ignore: ['node', 'pnpm'] } },
        },
      ],
      nodePin: null,
    }),
    [],
  );
});

test('a range with several branches passes when any branch is the baseline', () => {
  assert.deepEqual(
    messages({
      packages: [root({ dependencies: { next: '^15.0.0 || ^16.0.0' } })],
    }),
    [],
  );
  assert.deepEqual(
    messages({
      packages: [root({ dependencies: { next: '^14.0.0 || ^15.0.0' } })],
    }),
    [
      'package.json: next ^14.0.0 || ^15.0.0 in dependencies; the baseline is 16',
    ],
  );
});

test('an ignore list that is not an array of names is an error, not an empty list', () => {
  assert.throws(
    () => messages({ packages: [root({ fwdBaseline: { ignore: 'zod' } })] }),
    /package\.json: fwdBaseline\.ignore must be an array/,
  );
});

test('a Node pin that is not a version, or a missing root package.json, is reported', () => {
  assert.deepEqual(
    messages({ packages: [root({})], nodePin: pin('lts/*\n') }),
    [
      '.nvmrc: Node pin lts/* is not a version number; the baseline is at least 24.22.1',
    ],
  );
  assert.deepEqual(
    messages({ packages: [{ path: 'apps/web/package.json', json: {} }] }),
    [
      'package.json: no tracked root package.json, so packageManager cannot be checked',
    ],
  );
});

test('the CLI reads tracked package.json files, skips fixtures, and fails only in fail mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fwd-baseline-'));
  try {
    const write = (path, json) => {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), JSON.stringify(json));
    };
    write('package.json', {
      packageManager: 'pnpm@10.33.2',
      dependencies: { zod: '^3.0.0' },
    });
    write('tests/fixtures/app/package.json', { dependencies: { next: '14' } });
    write('untracked/package.json', { dependencies: { next: '14' } });
    writeFileSync(join(dir, '.nvmrc'), '24\n');
    writeFileSync(join(dir, 'baseline.json'), JSON.stringify(baseline));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', 'package.json', 'tests', '.nvmrc'], {
      cwd: dir,
    });

    const script = fileURLToPath(
      new URL('../scripts/baseline-check.mjs', import.meta.url),
    );
    const run = (mode) =>
      spawnSync(process.execPath, [script, 'baseline.json'], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, MODE: mode },
      });

    const warn = run('warn');
    assert.equal(warn.status, 0);
    assert.equal(
      warn.stdout,
      '::warning file=package.json,title=fwd baseline::zod ^3.0.0 in dependencies; the baseline is 4\n' +
        'fwd baseline: 1 mismatch(es), mode warn\n',
    );

    const fail = run('fail');
    assert.equal(fail.status, 1);
    assert.match(
      fail.stdout,
      /^::error file=package\.json,title=fwd baseline::zod/,
    );

    assert.notEqual(
      run('loud').status,
      0,
      'an unknown mode is an error, not a pass',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
