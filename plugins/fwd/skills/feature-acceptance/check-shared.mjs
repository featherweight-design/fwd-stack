#!/usr/bin/env node
// Do the routes that are supposed to share a component actually share it?
//
//   node ~/.claude/fwd/skills/feature-acceptance/check-shared.mjs <inventory.json> [--root DIR]
//
// The contact sheet shows that routes look alike; this answers the half a picture cannot: whether
// they look alike BECAUSE they render the same component, or by coincidence, and whether a route
// reaches the control through its own copy wearing the shared name. Every structural check of the
// form "does this route use the component" passes a per-route wrapper; this one does not.
//
// It reads the inventory's `shares` block and checks each row's `view` (a project-relative file)
// imports the named `binding` as a VALUE from the named `module` and references it. Static: no
// server, no browser, about a second. An inventory with no `shares` block has nothing to check.
//
// Parsing is TypeScript's own, from the project's node_modules: a hand-rolled matcher answered yes
// for an import quoted in a comment, inside a template literal, and across a blank line into a
// later re-export. A check that says yes for the wrong reason is the failure it exists to catch.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { isMain } from '../../lib/is-main.mjs';
import { inventoryErrors } from './inventory.mjs';
import {
  acceptanceConfig,
  importFromProject,
  parseArgs,
  projectRoot,
  runTool,
  SetupError,
} from './project.mjs';

/** Both separators: a test on macOS can never observe the host separator being wrong. */
export const toPosix = (p) => p.replace(/\\/g, '/');

/**
 * An import specifier as a project-relative path, extensionless and posix; null for a package.
 * `aliases` maps a prefix to a project-relative folder, e.g. { "@/": "src/" }.
 */
export function resolveSpecifier(file, specifier, aliases = {}) {
  const alias = Object.keys(aliases)
    .sort((a, b) => b.length - a.length)
    .find((prefix) => specifier.startsWith(prefix));
  const from = alias
    ? path.join(aliases[alias], specifier.slice(alias.length))
    : specifier.startsWith('.')
      ? path.join(path.dirname(file), specifier)
      : null;
  return from
    ? toPosix(path.normalize(from))
        .replace(/\.[cm]?[jt]sx?$/, '')
        .replace(/\/index$/, '')
    : null;
}

/**
 * Every binding an import brings in as a VALUE, by its EXPORTED name (a default import counts as
 * `default`), with the module it resolves to. Type-only imports, namespace imports and side-effect
 * imports bring none: each binds something other than the named export to a name that reads like it.
 */
function valueImports(ts, parsed, aliases) {
  const file = parsed.fileName;
  const found = [];
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const from = resolveSpecifier(
      file,
      statement.moduleSpecifier.text,
      aliases,
    );
    if (clause.name)
      found.push({ name: 'default', local: clause.name.text, from });
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings))
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue;
        found.push({
          name: (element.propertyName ?? element.name).text,
          local: element.name.text,
          from,
        });
      }
  }
  return found.concat(loadedOnDemand(ts, parsed, aliases));
}

/**
 * `const Local = wrap(() => import("./x").then((m) => m.Binding))`: a lazily loaded component takes
 * exactly one named export by a property read on the module. Any other callback shape is not counted.
 */
function loadedOnDemand(ts, parsed, aliases) {
  const found = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const then = node.parent;
      const call = then?.parent;
      const callback =
        call && ts.isCallExpression(call) && call.expression === then
          ? call.arguments[0]
          : null;
      if (
        ts.isPropertyAccessExpression(then) &&
        then.name.text === 'then' &&
        callback &&
        ts.isArrowFunction(callback) &&
        callback.parameters.length === 1 &&
        ts.isIdentifier(callback.parameters[0].name) &&
        ts.isPropertyAccessExpression(callback.body) &&
        ts.isIdentifier(callback.body.expression) &&
        callback.body.expression.text === callback.parameters[0].name.text
      ) {
        let owner = call.parent;
        while (
          owner &&
          !ts.isVariableDeclaration(owner) &&
          !ts.isSourceFile(owner)
        )
          owner = owner.parent;
        if (
          owner &&
          ts.isVariableDeclaration(owner) &&
          ts.isIdentifier(owner.name)
        )
          found.push({
            name: callback.body.name.text,
            local: owner.name.text,
            from: resolveSpecifier(
              parsed.fileName,
              node.arguments[0].text,
              aliases,
            ),
          });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(parsed, visit);
  return found;
}

/**
 * A USE of the name, not the name appearing: a property key, the right of `x.Thing`, or the name a
 * declaration introduces is not one. Positional, not symbol resolution, which needs a whole Program.
 */
function isUse(ts, node) {
  const parent = node.parent;
  if (!parent) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node)
    return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if (
    (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) &&
    parent.name === node
  )
    return false;
  if (
    (ts.isParameter(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isBindingElement(parent)) &&
    parent.name === node
  )
    return false;
  return true;
}

function isReferenced(ts, parsed, local) {
  let used = false;
  const visit = (node) => {
    if (used || ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node) && node.text === local && isUse(ts, node))
      used = true;
    else ts.forEachChild(node, visit);
  };
  ts.forEachChild(parsed, visit);
  return used;
}

/**
 * True when `source` imports `binding` as a value from `module` AND references it. The reference
 * matters: an unused import beside the route's own copy would otherwise pass.
 */
export function importsSharedBinding(
  ts,
  { source, file, module, binding, aliases = {} },
) {
  const target = toPosix(module)
    .replace(/\.[cm]?[jt]sx?$/, '')
    .replace(/\/index$/, '');
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  return valueImports(ts, parsed, aliases).some(
    (e) =>
      e.from === target &&
      e.name === binding &&
      isReferenced(ts, parsed, e.local),
  );
}

/** The distinct `{ view, binding, module }` pairs to check: one view may carry several rows. */
export function sharedPairs(inventory) {
  const entries = Array.isArray(inventory.shares)
    ? inventory.shares
    : [inventory.shares];
  const entryOf = (row) =>
    Array.isArray(inventory.shares)
      ? entries.find((e) => e.binding === row.binding)
      : entries[0];
  return [
    ...new Map(
      inventory.rows.map((row) => [
        `${row.view}\0${entryOf(row).binding}`,
        { view: row.view, ...entryOf(row) },
      ]),
    ).values(),
  ];
}

const MODULE_SPELLINGS = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '/index.ts',
  '/index.tsx',
  '/index.js',
];

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const root = projectRoot(flags);
  const inventoryPath = positional[0];
  if (!inventoryPath) throw new SetupError('pass the inventory JSON path');
  const cfg = acceptanceConfig(root);
  const aliases = cfg.aliases ?? {};
  const inventory = JSON.parse(
    await readFile(path.resolve(inventoryPath), 'utf8'),
  );
  const name = path.basename(inventoryPath);
  if (inventory.shares === undefined) {
    console.log(`${name} declares no "shares" block. Nothing to check.`);
    return;
  }
  // Widths are the contact sheet's concern; any label passes here.
  const labels = [
    ...new Set(inventory.rows?.flatMap?.((r) => r.widths ?? []) ?? []),
  ];
  const problems = inventoryErrors(inventory, labels);
  if (problems.length)
    throw new SetupError(
      `${name} is not checkable:\n  - ${problems.join('\n  - ')}`,
    );
  const ts = await importFromProject(
    root,
    ['typescript'],
    'check-shared parses views with the TypeScript compiler',
    cfg.packageDir,
  );

  const failures = [];
  const entries = Array.isArray(inventory.shares)
    ? inventory.shares
    : [inventory.shares];
  // A moved shared module would fail every view as "does not import": name the stale entry instead.
  for (const { module } of entries)
    if (
      !MODULE_SPELLINGS.some((ext) => existsSync(path.join(root, module + ext)))
    )
      failures.push(
        `${module} is named in "shares" but does not exist: moved? update the entry`,
      );
  const pairs = sharedPairs(inventory);
  for (const { view, binding, module } of pairs) {
    let source;
    try {
      source = await readFile(path.join(root, view), 'utf8');
    } catch (error) {
      failures.push(
        error?.code === 'ENOENT'
          ? `${view} is named in the rows but does not exist: moved? update the row's "view"`
          : `${view}: could not be read (${error?.code ?? error})`,
      );
      continue;
    }
    if (
      !importsSharedBinding(ts, {
        source,
        file: view,
        module,
        binding,
        aliases,
      })
    )
      failures.push(
        `${view}: does not import and use ${binding} from ${module}. Its own wrapper, a constant or type only, or an unused import all fail.`,
      );
  }
  const named = entries.map((e) => e.binding).join(', ');
  if (failures.length) {
    console.error(`${name}: ${failures.length} problem(s) sharing ${named}:\n`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error(
      '\nA shared wrapper is a legitimate answer; a wrapper each is not. Point "module" at the shared wrapper.',
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `${name}: all ${pairs.length} view and control pairs import and use ${named}.`,
  );
}

if (isMain(import.meta.url)) await runTool('check-shared', main);
