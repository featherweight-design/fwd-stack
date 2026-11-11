#!/usr/bin/env node
// The token guard: every `var(--x)` a component or stylesheet reads must resolve to a token a theme
// declares, and hard-coded hex colours in component folders are reported.
//
//   node ~/.claude/fwd/skills/feature-acceptance/check-tokens.mjs [--root DIR] [--strict-hex]
//
// What it is about is SILENCE. An unset custom property with no fallback contributes nothing and
// reports nothing: a gradient built from two tokens no palette has ever had renders as a void, and
// TypeScript, the linter and jsdom all pass it. Two rules follow:
//   - a read WITH a fallback, `var(--x, 3s)`, is a parameter with a default, not a miss;
//   - a token a component declares counts for reads in that same file only, never another file's.
// Stylesheets are the one asymmetry: a rule selects by class and a component draws that element, so
// a stylesheet may resolve against any component's declaration. The reverse does not hold.
//
// Hex colours are reported, not failed, unless featureAcceptance.tokens.hexFails or --strict-hex:
// a colour outside the theme is drift from the design system, but some (an SVG asset's fill, a
// third-party brand mark) are deliberate. A line carrying `fwd-allow-hex` is skipped.
//
// Files come from featureAcceptance.tokens in the project's .claude/fwd.json: `declare` (theme
// files), `read` (globs whose reads are checked), `hex` (component-folder globs). Test files are
// skipped: a token a test fixture declares is not declared for the app.
import { glob, readFile } from 'node:fs/promises';
import path from 'node:path';

import { isMain } from '../../lib/is-main.mjs';
import {
  acceptanceConfig,
  need,
  parseArgs,
  projectRoot,
  runTool,
  SetupError,
} from './project.mjs';

/**
 * Comments out, so `// --ghost: the old name` declares nothing and `// var(--gone)` reads nothing.
 * Block comments become spaces (newlines kept, so line numbers survive). A `//` right after a
 * colon, quote, backtick, `(`, `=` or word character is a URL or a path (`https://`,
 * `src="//cdn/x.png"`, `url(//cdn)`), not a comment.
 */
export function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:"'`(=\w/\\])\/\/[^\n]*/g, '$1');
}

// A token name: letters, digits, dashes and underscores.
const NAME = '--[\\w-]+';

/** `--x` left of a `:` (a CSS declaration or a quoted style key), and next/font's `variable: "--x"`. */
export function declarationsIn(raw) {
  const text = stripComments(raw);
  const found = new Set();
  // Not after a word character or dash: `.btn--primary:hover` is a class, not a declaration.
  for (const m of text.matchAll(
    new RegExp(`(?<![\\w-])["']?(${NAME})["']?\\s*:`, 'g'),
  ))
    found.add(m[1]);
  for (const m of text.matchAll(
    new RegExp(`variable:\\s*["'](${NAME})["']`, 'g'),
  ))
    found.add(m[1]);
  return found;
}

/**
 * Every token a source reads and depends on resolving. Each `var(` is matched alone, so a nested
 * fallback falls out: `var(--a, var(--b))` skips `--a` (it has a default) and checks `--b`.
 * `var(--${on ? "x" : "y"})` checks both literals; an interpolation with none yields nothing.
 */
export function usedTokens(raw) {
  const used = [];
  for (const m of stripComments(raw).matchAll(
    /var\(\s*(--[\w-]*)(\$\{([^}]*)\})?\s*(,)?/g,
  )) {
    const [, stem, , expr, comma] = m;
    if (comma) continue;
    if (!expr) {
      // `var(--fg-${tone})` leaves a stem ending in a dash: unresolvable, so not a miss.
      if (!stem.endsWith('-')) used.push(stem);
      continue;
    }
    for (const lit of expr.matchAll(/["'`]([\w-]+)["'`]/g))
      used.push(`${stem}${lit[1]}`);
  }
  return used;
}

/**
 * `files` ({ path, source }) are checked for reads; `globals` declare for everyone; each file also
 * declares for itself; `stylesheets` (a set of paths) may resolve against any component's tokens.
 */
export function undeclaredIn(files, globals, stylesheets = new Set()) {
  const global = new Set(globals.flatMap((s) => [...declarationsIn(s)]));
  const componentDeclared = new Set();
  for (const { path: p, source } of files)
    if (!stylesheets.has(p))
      for (const t of declarationsIn(source)) componentDeclared.add(t);
  const misses = [];
  for (const { path: p, source } of files) {
    const local = declarationsIn(source);
    for (const token of new Set(usedTokens(source))) {
      if (global.has(token) || local.has(token)) continue;
      if (stylesheets.has(p) && componentDeclared.has(token)) continue;
      misses.push({ file: p, token });
    }
  }
  return misses;
}

/**
 * Hex colour literals (#rgb, #rgba, #rrggbb, #rrggbbaa) outside comments, with their line numbers.
 * Not after a word character or `&` (an anchor id, an HTML entity), not followed by one (`#abcdef0`
 * is no colour). A line carrying `fwd-allow-hex` is skipped.
 */
export function hexColours(raw) {
  const text = stripComments(raw);
  const rawLines = raw.split('\n');
  const found = [];
  text.split('\n').forEach((line, i) => {
    if (rawLines[i]?.includes('fwd-allow-hex')) return;
    for (const m of line.matchAll(/(?<![\w&])#([0-9a-fA-F]{3,8})(?![\w-])/g))
      if ([3, 4, 6, 8].includes(m[1].length))
        found.push({ line: i + 1, hex: `#${m[1]}` });
  });
  return found;
}

const TEST_FILE =
  /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|node_modules)\//;

/** Project-relative posix paths matching any of `patterns`, test files and node_modules out. */
export async function filesMatching(root, patterns) {
  const out = new Set();
  for (const pattern of patterns)
    for await (const f of glob(pattern, {
      cwd: root,
      // Never walk an install: a root `**` would read every package.
      exclude: (p) => path.basename(String(p?.name ?? p)) === 'node_modules',
    })) {
      const p = f.split(path.sep).join('/');
      if (!TEST_FILE.test(p)) out.add(p);
    }
  return [...out].sort();
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2), {
    valued: ['root'],
    switches: ['strict-hex'],
  });
  const root = projectRoot(flags);
  const cfg = acceptanceConfig(root);
  // A string or a list of globs.
  const declare = [
    need(
      cfg,
      'tokens.declare',
      'the theme files whose `--x:` declarations are global',
    ),
  ].flat();
  const readGlobs = [
    need(cfg, 'tokens.read', 'the globs whose var(--x) reads must resolve'),
  ].flat();
  const hexGlobs = [cfg.tokens.hex ?? []].flat();
  const declareFiles = await filesMatching(root, declare);
  if (declareFiles.length === 0)
    throw new SetupError(
      `tokens.declare matches no file: ${declare.join(', ')}`,
    );
  const paths = await filesMatching(root, readGlobs);
  if (paths.length === 0)
    throw new SetupError(
      `tokens.read matches no file: ${readGlobs.join(', ')}`,
    );

  const read = async (p) => ({
    path: p,
    source: await readFile(path.join(root, p), 'utf8'),
  });
  const files = await Promise.all(paths.map(read));
  const globals = (await Promise.all(declareFiles.map(read))).map(
    (f) => f.source,
  );
  const stylesheets = new Set(paths.filter((p) => /\.(s?css|less)$/.test(p)));
  const misses = undeclaredIn(files, globals, stylesheets);
  for (const { file, token } of misses)
    console.error(`${file} reads ${token}, which nothing declares`);

  let hexCount = 0;
  const hexFails = flags['strict-hex'] === true || cfg.tokens.hexFails === true;
  if (hexGlobs.length === 0)
    console.log(
      'hex: tokens.hex is not set, so hard-coded colours are not reported',
    );
  else
    for (const p of await filesMatching(root, hexGlobs)) {
      const { source } = await read(p);
      for (const { line, hex } of hexColours(source)) {
        hexCount++;
        console.log(
          `${p}:${line} hard-codes ${hex}: use a theme token (or mark the line fwd-allow-hex)`,
        );
      }
    }

  console.log(
    `\n${files.length} files read: ${misses.length} undeclared token read(s), ${hexCount} hard-coded hex colour(s)` +
      (hexCount && !hexFails ? ' (reported, not failed)' : ''),
  );
  if (misses.length || (hexFails && hexCount)) process.exitCode = 1;
}

if (isMain(import.meta.url)) await runTool('check-tokens', main);
