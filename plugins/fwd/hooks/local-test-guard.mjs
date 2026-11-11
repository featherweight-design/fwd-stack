#!/usr/bin/env node
// PreToolUse guard for Bash: denies running a test suite or a production build on the user's
// machine. Local checks are typecheck and lint only; CI is the only test gate (pr-review §5).
//
// It denies a command when any simple command in it runs:
//
//   - a test runner: vitest, jest, `playwright test`, mocha, `node --test`, `tsx --test`,
//     `bun test`, pytest (or `python -m pytest`), `go test`, `cargo test`, `deno test`;
//   - a package script named `test`, `test:*`, `build` or `build:*` through pnpm, npm, yarn or
//     bun, with or without `run`, filters (`-r`, `--filter X`, `-w X`) or a yarn workspace;
//   - a runner reached through `pnpm exec`, `pnpm dlx`, `npx`, `bunx`, `yarn dlx`, `dotenv --`,
//     `cross-env`, or a binary pnpm/yarn/bun runs by name (`pnpm vitest`, `pnpm turbo build`);
//   - a turbo task named `test`, `test:*`, `build` or `build:*` (`web#build` too);
//   - `next build` or `vite build`.
//
// The command is split the way secret-guard.mjs splits it (pipes, lists, newlines, subshells,
// `$(...)`, backticks), wrappers such as `timeout`, `env` and `xargs` are peeled off, and
// `bash -c`, `eval`, `watch` and shell heredocs are parsed again. Quoted text is data and only the
// command word decides, so `grep vitest`, `echo "run tests"`, a `test:` commit message or
// `cat foo.test.ts` pass. Typecheck, lint, tsc, eslint and `gh run` are never matched.
import { readFileSync } from 'node:fs';

import { isMain } from '../lib/is-main.mjs';
import {
  SHELLS,
  basename,
  isOption,
  parseCommands,
  unwrap,
} from './secret-guard.mjs';

// A script or task name that runs tests or a production build.
const SCRIPT = /^(test|build)(:.*)?$/;
const TURBO_TASK = /(^|#)(test|build)(:[^#]*)?$/;
const INFO = /^(-v|-h|--version|--help)$/;

// Binaries that are themselves a test runner, whatever their arguments.
const RUNNERS = new Set(['vitest', 'jest', 'mocha', 'pytest', 'py.test']);
// Binaries a package manager may run by name, which this guard then judges as commands.
const RUNNABLE = new Set([
  ...RUNNERS,
  'playwright',
  'turbo',
  'next',
  'vite',
  'tsx',
  'node',
  'dotenv',
  'cross-env',
]);

// Value-taking options of the package managers, so their value is not read as the command.
const PM_VALUE = new Set([
  '--filter',
  '-F',
  '-C',
  '--dir',
  '--prefix',
  '--cwd',
  '--workspace',
  '--reporter',
  '--loglevel',
  '--test-pattern',
  '--changed-files-ignore-pattern',
  '--workspace-concurrency',
  '--network-concurrency',
  '--child-concurrency',
  '--tag',
  '--registry',
  '--otp',
  '--access',
  '--userconfig',
  '--cache',
]);
// The first positional of a command, skipping options. `value` lists options that take the
// next word as their value.
function firstPositional(args, value = new Set()) {
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') return k + 1 < args.length ? k + 1 : -1;
    if (!isOption(a)) return k;
    if (value.has(a)) k++;
  }
  return -1;
}

// Runtime options of node, tsx and deno that take the next word as their value.
const NODE_VALUE = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '-C',
  '--conditions',
  '-e',
  '--eval',
  '-p',
  '--print',
  '--env-file',
  '--input-type',
  '--run',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-name-pattern',
  '--test-skip-pattern',
  '--test-concurrency',
]);
// Global options of go and cargo that take the next word as their value.
const GO_CARGO_VALUE = new Set(['-C', '--config', '-Z', '--color']);
// npm commands that install and then run the test script.
const NPM_TEST = new Set([
  'test',
  't',
  'tst',
  'it',
  'install-test',
  'cit',
  'clean-install-test',
  'install-ci-test',
  'sit',
]);
// turbo options that take the next word as their value, so `--cache-dir build` is not a task.
const TURBO_VALUE = new Set([
  '--filter',
  '-F',
  '--cache-dir',
  '--out-dir',
  '--concurrency',
  '--cwd',
  '--env-mode',
  '--log-order',
  '--log-prefix',
  '--output-logs',
  '--profile',
  '--team',
  '--token',
  '--api',
  '--scope',
  '--ui',
]);

// turbo subcommands that run no task, so a later `build` word is an argument, not a task.
const TURBO_OTHER = new Set([
  'prune',
  'gen',
  'generate',
  'login',
  'logout',
  'link',
  'unlink',
  'ls',
  'query',
  'info',
  'daemon',
  'telemetry',
  'boundaries',
  'scan',
  'bin',
  'completion',
  'config',
  'devtools',
]);

const LOCAL =
  'Local checks are typecheck and lint only: push and let CI run tests and builds (pr-review §5).';

// The reason a package-manager command runs tests or a build, or null.
function packageManagerRule(name, args, depth) {
  // npm's `-w` names a workspace; pnpm's is the root flag.
  const value = new Set(PM_VALUE);
  if (name === 'npm') value.add('-w');
  // yarn workspaces foreach --include/--exclude/--from <glob>, -j <n>
  if (name === 'yarn')
    for (const o of ['--include', '--exclude', '--from', '-j', '--jobs'])
      value.add(o);
  let rest = args;
  for (;;) {
    const k = firstPositional(rest, value);
    if (k === -1) return null;
    const cmd = rest[k];
    const after = rest.slice(k + 1);
    if (cmd === 'run' || cmd === 'run-script') {
      const s = firstPositional(after, value);
      if (s === -1) return null;
      if (SCRIPT.test(after[s]))
        return `\`${name} run ${after[s]}\` runs a test or build script.`;
      // yarn and bun `run` a binary when no script has the name.
      if (name !== 'npm' && RUNNABLE.has(basename(after[s])))
        return judgeWords(after.slice(s), depth + 1);
      return null;
    }
    if (NPM_TEST.has(cmd) || SCRIPT.test(cmd))
      return `\`${name} ${cmd}\` runs a test or build script.`;
    // yarn workspace <name> <cmd>, yarn workspaces foreach <cmd>
    if (name === 'yarn' && cmd === 'workspace') {
      rest = after.slice(1);
      continue;
    }
    if (name === 'yarn' && cmd === 'workspaces') {
      rest = after[0] === 'foreach' ? after.slice(1) : [];
      continue;
    }
    if (cmd === 'exec' || cmd === 'dlx' || cmd === 'x') {
      const b = firstPositional(after, value);
      if (b === -1) return null;
      // `pnpm exec -c "vitest run"` runs its argument as a shell command.
      const shell = after
        .slice(0, b)
        .some((a) => a === '-c' || a === '--shell-mode');
      return shell
        ? judge(after[b], depth + 1)
        : judgeWords(after.slice(b), depth + 1);
    }
    // pnpm, yarn and bun run a binary when no script has the name.
    if (name !== 'npm' && RUNNABLE.has(basename(cmd)))
      return judgeWords(rest.slice(k), depth + 1);
    return null;
  }
}

// The reason one simple command (its words, wrappers already peeled) runs tests or a build.
function judgeWords(words, depth) {
  if (depth > 8 || !words.length) return null;
  const name = basename(words[0]);
  const args = words.slice(1);
  const only = args.length === 1 && INFO.test(args[0]);

  if (RUNNERS.has(name)) return only ? null : `\`${name}\` runs tests.`;
  if (name === 'playwright' && args[firstPositional(args)] === 'test')
    return '`playwright test` runs tests.';
  if (name === 'node' || name === 'tsx' || name === 'deno') {
    // Options before the script are the runtime's; `--test` there runs the test runner.
    const k = firstPositional(args, NODE_VALUE);
    const opts = k === -1 ? args : args.slice(0, k);
    if (opts.some((a) => a === '--test' || a.startsWith('--test=')))
      return `\`${name} --test\` runs tests.`;
    // `node --run test` runs a package.json script.
    for (let j = 0; j < opts.length; j++) {
      const script = opts[j].startsWith('--run=')
        ? opts[j].slice(6)
        : opts[j] === '--run'
          ? args[j + 1]
          : undefined;
      if (script !== undefined && SCRIPT.test(script))
        return `\`${name} --run ${script}\` runs a test or build script.`;
    }
    if (name === 'deno' && args[k] === 'test') return '`deno test` runs tests.';
    return null;
  }
  if (/^python[\d.]*$/.test(name)) {
    // Only interpreter options count: `python manage.py -m pytest` passes `-m` to the script.
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (a === '-m')
        return /^(pytest|unittest)$/.test(args[k + 1] ?? '')
          ? `\`${name} -m ${args[k + 1]}\` runs tests.`
          : null;
      if (a === '-c' || !isOption(a)) return null;
      if (a === '-W' || a === '-X') k++;
    }
    return null;
  }
  // `cargo +nightly test`, `cargo --locked test`, `go -C dir test`: global options come first.
  if (name === 'go' || name === 'cargo') {
    const sub = args.filter((a) => !a.startsWith('+'));
    return sub[firstPositional(sub, GO_CARGO_VALUE)] === 'test'
      ? `\`${name} test\` runs tests.`
      : null;
  }
  if (name === 'turbo') {
    // Positionals up to `--` (the rest is passed through to the tasks).
    const pos = [];
    for (let k = 0; k < args.length && args[k] !== '--'; k++) {
      if (TURBO_VALUE.has(args[k])) k++;
      else if (!isOption(args[k])) pos.push(args[k]);
    }
    // Only `turbo run`, `turbo watch` and the bare `turbo <task>` run tasks.
    if (TURBO_OTHER.has(pos[0])) return null;
    const task = pos.find((a) => TURBO_TASK.test(a));
    return task ? `\`turbo ${task}\` runs a test or build task.` : null;
  }
  if (
    (name === 'next' || name === 'vite') &&
    args[firstPositional(args)] === 'build'
  )
    return `\`${name} build\` runs a production build.`;
  if (name === 'npx' || name === 'pnpx' || name === 'bunx') {
    // `npx -c "vitest run"` runs its value as a shell command.
    for (let j = 0; j < args.length; j++) {
      if (args[j] === '-c' || args[j] === '--call')
        return j + 1 < args.length ? judge(args[j + 1], depth + 1) : null;
      if (args[j].startsWith('--call='))
        return judge(args[j].slice(7), depth + 1);
      if (!isOption(args[j])) break;
    }
    const k = firstPositional(args, new Set(['-p', '--package']));
    return k === -1 ? null : judgeWords(args.slice(k), depth + 1);
  }
  if (name === 'pnpm' || name === 'npm' || name === 'yarn' || name === 'bun')
    return packageManagerRule(name, args, depth);
  if (name === 'dotenv') {
    const dd = args.indexOf('--');
    if (dd !== -1) return judgeWords(args.slice(dd + 1), depth + 1);
    const k = firstPositional(args, new Set(['-e', '-v', '-c']));
    return k === -1 ? null : judgeWords(args.slice(k), depth + 1);
  }
  if (name === 'cross-env' || name === 'cross-env-shell') {
    const rest = args.filter((a) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(a));
    // cross-env-shell hands its words to a shell, which reads leading assignments itself; a
    // quoted `"NODE_ENV=test pnpm test"` is one word, so filtering it would drop the command.
    return name === 'cross-env-shell'
      ? judge(args.join(' '), depth + 1)
      : judgeWords(rest, depth + 1);
  }
  return null;
}

function judgeSegment(seg, depth) {
  const unwrapped = unwrap(seg.words);
  if (unwrapped.skip || unwrapped.envDump) return null;
  if (unwrapped.nested !== undefined) return judge(unwrapped.nested, depth + 1);
  const words = unwrapped.words;
  if (!words.length) return null;
  const name = basename(words[0]);
  const args = words.slice(1);
  if (name === 'eval') return judge(args.join(' '), depth + 1);
  if (SHELLS.has(name)) {
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))
        return k + 1 < args.length ? judge(args[k + 1], depth + 1) : null;
      if (/^[-+][a-zA-Z]*[oO]$/.test(a)) k++;
      else if (!isOption(a) && !a.startsWith('+')) return null; // a script file
    }
    for (const body of seg.heredocs) {
      const r = judge(body, depth + 1);
      if (r) return r;
    }
    for (const r of seg.redirects)
      if (r.op === '<<<') {
        const out = judge(r.target, depth + 1);
        if (out) return out;
      }
    return null;
  }
  return judgeWords(words, depth);
}

function judge(command, depth = 0) {
  if (depth > 8) return null;
  for (const seg of parseCommands(command)) {
    const reason = judgeSegment(seg, depth);
    if (reason) return reason;
  }
  return null;
}

// Returns the denial message, or null when the command is allowed.
export function localTestDecision(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const reason = judge(command);
  return reason ? `${reason} ${LOCAL}` : null;
}

if (isMain(import.meta.url)) {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }
  if (input?.tool_name !== undefined && input.tool_name !== 'Bash')
    process.exit(0);
  let reason = null;
  try {
    reason = localTestDecision(input?.tool_input?.command);
  } catch {
    // A parser failure must never block work; this guard catches habits, it is not a sandbox.
    process.exit(0);
  }
  if (reason)
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `local-test-guard: ${reason}`,
        },
      }),
    );
}
