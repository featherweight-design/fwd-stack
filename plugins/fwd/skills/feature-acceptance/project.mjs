// What the feature-acceptance tools need from the project they run in: its root, the
// `featureAcceptance` block of its `.claude/fwd.json`, and the packages it already installs
// (Playwright, TypeScript). The kit adds no dependency to a project; each tool loads what it needs
// from the project's own node_modules and says so loudly when that is missing.
//
//   "featureAcceptance": {
//     "baseUrl": "http://localhost:3000",             // contact sheet: the local dev server pre-PR
//     "productionUrl": ["https://app.example.com"],   // every production origin; refused as a base
//     "widths": [{ "label": "phone", "width": 390, "height": 844 },
//                { "label": "desktop", "width": 1300, "height": 900 }],
//     "themes": [{ "label": "light", "storage": { "app-theme": "light" }, "dataTheme": "light" },
//                { "label": "dark", "cookies": [{ "name": "theme", "value": "dark" }],
//                  "colorScheme": "dark", "dataTheme": "dark" }],
//                                                     // optional: the sheet once per theme
//     "pageScope": "main",                            // selector page content lives in ("" = none)
//     "signIn": "scripts/contact-sheet-sign-in.mjs",  // module exporting signIn(page, { baseUrl })
//     "inventories": "docs/superpowers/inventories",  // where a feature's inventory JSON lives
//     "out": "contact-sheets",                        // gitignored; one folder per inventory
//     "aliases": { "@/": "src/" },                    // import aliases, for check-shared
//     "packageDir": ["apps/e2e", "apps/web"],         // monorepo: folders searched for playwright
//                                                     //   and typescript, in order (or one string)
//     "tokens": {
//       "declare": ["src/app/globals.css"],           // theme files: every `--x:` here is global
//       "read": ["src/**/*.{ts,tsx,css}"],            // files whose var(--x) reads must resolve
//       "hex": ["src/components/**/*.{ts,tsx}"],      // component dirs to report hex colours in
//       "hexFails": false                             // true: a hex colour fails the run
//     }
//   }
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig } from '../../lib/fwd-config.mjs';
import { redact } from './inventory.mjs';

/** Exit code for a tool that cannot run: missing config, bad inventory, missing package. */
export const SETUP_FAILED = 2;

export class SetupError extends Error {}

/**
 * `--name value` flags and positional arguments. `valued` flags take a value and `switches` take
 * none; anything else is a SetupError, so a typo'd `--strict-hx` cannot quietly leave a check soft.
 */
export function parseArgs(argv, { valued = [], switches = [] } = {}) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (switches.includes(name)) flags[name] = true;
    else if (!valued.includes(name))
      throw new SetupError(`unknown flag ${arg}`);
    else if (argv[i + 1] === undefined || argv[i + 1].startsWith('--'))
      throw new SetupError(`${arg} takes a value`);
    else flags[name] = argv[++i];
  }
  return { flags, positional };
}

/** The inventory JSON, or a SetupError: a missing or malformed file is not a run. */
export async function readInventory(file) {
  if (!file) throw new SetupError('pass the inventory JSON path');
  let text;
  try {
    text = await readFile(path.resolve(file), 'utf8');
  } catch (error) {
    throw new SetupError(`cannot read ${file}: ${error.code ?? error}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SetupError(`${file} is not JSON: ${error.message}`);
  }
}

/** `--root`, else the git toplevel of the working directory, else the working directory. */
export function projectRoot(flags, cwd = process.cwd()) {
  if (typeof flags.root === 'string') return path.resolve(cwd, flags.root);
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return cwd;
  }
}

/**
 * The project's `featureAcceptance` block. A project with none has not set the tools up, and that
 * is a loud failure: a tool that quietly fell back to defaults would check some other app's shape.
 */
export function acceptanceConfig(root, load = loadConfig) {
  const cfg = load({ ...process.env, CLAUDE_PROJECT_DIR: root });
  if (cfg.invalid?.length)
    throw new SetupError(`not a JSON object: ${cfg.invalid.join(', ')}`);
  const block = cfg.featureAcceptance;
  if (!block || typeof block !== 'object')
    throw new SetupError(
      `${path.join(root, '.claude', 'fwd.json')} has no "featureAcceptance" block. ` +
        "Its fields are listed at the top of the kit's feature-acceptance/project.mjs.",
    );
  return block;
}

/** A required field of the block, or a SetupError naming it. */
export function need(block, key, what) {
  const value = key.split('.').reduce((v, k) => v?.[k], block);
  const empty =
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0);
  if (empty)
    throw new SetupError(
      `.claude/fwd.json featureAcceptance.${key} is not set: ${what}`,
    );
  return value;
}

/**
 * A package from the project's node_modules, never the kit's: each `packageDir` folder in order
 * (featureAcceptance.packageDir, one folder or a list, for a monorepo whose Playwright and
 * TypeScript live in different apps), then the root.
 */
export async function importFromProject(root, names, why, packageDir = '.') {
  const listed = [packageDir ?? '.'].flat();
  if (listed.some((d) => typeof d !== 'string' || !d))
    throw new SetupError(
      'featureAcceptance.packageDir is a folder, or a list of folders',
    );
  const dirs = [
    ...new Set([...listed.map((d) => path.resolve(root, d)), root]),
  ];
  for (const dir of dirs)
    for (const name of names) {
      let resolved;
      try {
        resolved = createRequire(path.join(dir, 'package.json')).resolve(name);
      } catch {
        continue;
      }
      // Both packages are CommonJS: the namespace's default is the whole module.exports.
      const mod = await import(pathToFileURL(resolved).href);
      return mod.default ?? mod;
    }
  throw new SetupError(
    `${names.join(' or ')} is not installed in ${dirs.join(' or ')}: ${why}. ` +
      'Add it as a devDependency, or set featureAcceptance.packageDir to the folder that has it.',
  );
}

/** A project-relative module (the sign-in helper), imported by path. */
export async function importProjectFile(root, rel) {
  const abs = path.resolve(root, rel);
  if (!existsSync(abs))
    throw new SetupError(`${rel} does not exist under ${root}`);
  return import(pathToFileURL(abs).href);
}

/**
 * Runs a tool's main, turning a SetupError into a named message and exit code 2. Any other error
 * prints its stack and exits 1, both redacted: an uncaught error would print an expanded `${VAR}`.
 */
export async function runTool(name, main, log = console.error) {
  try {
    await main();
  } catch (error) {
    if (error instanceof SetupError) {
      log(redact(`${name}: ${error.message}`));
      process.exitCode = SETUP_FAILED;
    } else {
      log(redact(`${name}: ${error?.stack ?? error}`));
      process.exitCode = 1;
    }
  }
}
