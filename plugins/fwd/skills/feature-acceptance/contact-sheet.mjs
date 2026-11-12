#!/usr/bin/env node
// The contact sheet: every route a feature touches, at every width, in one image.
//
//   node ~/.claude/fwd/skills/feature-acceptance/contact-sheet.mjs <inventory.json> [--base URL] [--root DIR]
//
// NOT a probe. A probe asserts what its author believed; this asserts nothing about the pixels. It
// loads each surface, photographs it, and lays the photographs out so a person sees in one glance
// that a route never got the feature, or that the phone is wrong while the desktop is right: the
// two failures a diff and a per-PR review cannot show.
//
// It reports one thing in its exit code: whether every cell was REACHED. A row whose steps time out
// has no evidence in it, and a sheet with a hole that exited 0 would be the quiet pass this exists
// to prevent. So does a run that photographed nothing. Exit 1 then; exit 2 when it cannot run.
//
// Before a PR opens, point it at the lane's local DEV server (`pnpm dev`, http://localhost:<port>;
// never a build): that is the only place the change exists yet. After merge, staging or a preview
// serves audits. The configured production origin is refused. The base is `--base`, else
// CONTACT_SHEET_BASE, else featureAcceptance.baseUrl. Playwright comes from the project's own
// node_modules, and signing in is the project's module (featureAcceptance.signIn), so nothing here
// knows any one app. One script for every project: a feature adds an inventory, never a script.
/* global window, document, getComputedStyle -- page.evaluate callbacks run in the browser */
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { inspect } from 'node:util';

import { isMain } from '../../lib/is-main.mjs';
import {
  baseUrlError,
  expand,
  inventoryErrors,
  redact,
  registerSecretEnv,
  registerSecrets,
  sheetHtml,
  themeErrors,
  widthErrors,
} from './inventory.mjs';
import {
  acceptanceConfig,
  importFromProject,
  importProjectFile,
  need,
  parseArgs,
  projectRoot,
  readInventory,
  runTool,
  SetupError,
} from './project.mjs';

const T = 15_000;

/**
 * One step's verbs, in VERBS order. Page content is reached inside `scope`, never the shell.
 * Exported for its tests, which drive it with a stand-in page.
 */
export async function runStep(page, step, { base, scope, env = process.env }) {
  const onPage = (sel) =>
    (scope ? page.locator(scope).locator(sel) : page.locator(sel)).first();
  if (step.route !== undefined) {
    // Answers this row's matching requests; the run clears every route when the row ends.
    const json = step.body !== undefined && typeof step.body !== 'string';
    await page.route(expand(step.route, 'route', env), (route) =>
      route.fulfill({
        status: step.status ?? 200,
        body: json ? JSON.stringify(step.body) : (step.body ?? ''),
        ...(json ? { contentType: 'application/json' } : {}),
      }),
    );
  }
  if (step.goto !== undefined) {
    const asked = new URL(
      `${base}${expand(step.goto, 'goto', env, { forPath: true })}`,
    );
    const response = await page.goto(asked.href, {
      waitUntil: 'domcontentloaded',
    });
    // An error page is a reached cell showing nothing: fail it rather than photograph it, unless
    // the row says it is photographing that error page (`expectStatus`).
    const status = response?.status();
    if (step.expectStatus !== undefined) {
      if (status !== step.expectStatus)
        throw new Error(
          `goto ${step.goto}: expected HTTP ${step.expectStatus}, got ${status ?? 'no response'}`,
        );
    } else if (status >= 400)
      throw new Error(`goto ${step.goto}: HTTP ${status}`);
    // So is a redirect: to sign-in, to home, to another origin. Write the goto as the final path,
    // or name the redirect the row is photographing (`expectRedirect`).
    const landed = new URL(page.url());
    const trim = (p) => p.replace(/(.)\/$/, '$1');
    const want = step.expectRedirect ?? asked.pathname;
    if (landed.origin !== asked.origin || trim(landed.pathname) !== trim(want))
      throw new Error(
        `goto ${step.goto} landed on ${landed.origin === asked.origin ? landed.pathname : landed.origin + landed.pathname}` +
          (step.expectRedirect ? `, not ${step.expectRedirect}` : ''),
      );
  }
  if (step.store !== undefined)
    await page.evaluate((items) => {
      for (const [k, v] of Object.entries(items))
        window.localStorage.setItem(k, String(v));
    }, step.store);
  if (step.click !== undefined) await onPage(step.click).click({ timeout: T });
  if (step.clickRole !== undefined) {
    const name = new RegExp(
      expand(step.name, `clickRole ${step.clickRole}`, env, {
        forRegex: true,
      }),
    );
    const root = scope ? page.locator(scope) : page;
    await root
      .getByRole(step.clickRole, { name })
      .first()
      .click({ timeout: T });
  }
  if (step.fill !== undefined)
    await onPage(step.fill).fill(expand(step.text, `fill ${step.fill}`, env), {
      timeout: T,
    });
  if (step.wait !== undefined)
    await onPage(step.wait).waitFor({ state: 'visible', timeout: T });
  if (step.waitDialog !== undefined) {
    // A regex, like clickRole's name: `^Filters$` for an exact name.
    const name = new RegExp(
      expand(step.waitDialog, 'waitDialog', env, { forRegex: true }),
    );
    await page
      .getByRole('dialog', { name })
      .first()
      .waitFor({ state: 'visible', timeout: T });
  }
  // A tag in the head (or streamed into the body, as Next does for metadata) that the pixels cannot
  // show: a soft 404's `robots: noindex`, say. Waits for it like `wait`, then names what it found.
  if (step.expectMeta !== undefined) {
    const name = step.expectMeta;
    const pattern = step.content;
    const matches = ([n, p]) =>
      [...document.querySelectorAll('meta')].some(
        (m) =>
          (m.getAttribute('name') === n || m.getAttribute('property') === n) &&
          new RegExp(p).test(m.getAttribute('content') ?? ''),
      );
    const found = await page
      .waitForFunction(matches, [name, pattern], { timeout: T })
      .then(
        () => true,
        () => false,
      );
    if (!found) {
      const contents = await page
        .evaluate(
          (n) =>
            [...document.querySelectorAll('meta')]
              .filter(
                (m) =>
                  m.getAttribute('name') === n ||
                  m.getAttribute('property') === n,
              )
              .map((m) => m.getAttribute('content') ?? ''),
          name,
        )
        .catch(() => []);
      throw new Error(
        contents.length
          ? `meta ${name}: content ${JSON.stringify(contents)} does not match /${pattern}/`
          : `meta ${name}: not on the page`,
      );
    }
  }
  if (step.hover !== undefined) await onPage(step.hover).hover({ timeout: T });
  if (step.back) {
    // goBack resolves null when there is nowhere to go: a no-op that would photograph this page.
    const before = page.url();
    await page.goBack();
    if (page.url() === before)
      throw new Error('back: there was no page to go back to');
  }
  if (step.offline !== undefined) await page.context().setOffline(step.offline);
  if (step.pressKey !== undefined) await page.keyboard.press(step.pressKey);
  if (step.settle !== undefined) await page.waitForTimeout(step.settle);
  // Last, after the wait and the settle: a scroll applied to a page still streaming is clamped to
  // a document that has not arrived, and the cell photographs the top while naming the foot.
  if (step.scrollTo !== undefined) {
    const target = onPage(step.scrollTo);
    await target.waitFor({ state: 'attached', timeout: T });
    await target.evaluate((node) => node.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(250);
  }
  if (typeof step.scroll === 'number')
    await page.evaluate((y) => window.scrollTo(0, y), step.scroll);
  if (step.scroll === 'bottom')
    await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      // And any element that is the real scroller, or the cell shows the top while claiming the foot.
      for (const node of document.querySelectorAll('body *')) {
        const y = getComputedStyle(node).overflowY;
        if (
          (y === 'auto' || y === 'scroll') &&
          node.scrollHeight - node.clientHeight > 1
        )
          node.scrollTop = node.scrollHeight;
      }
    });
}

/**
 * A failed cell's note: the error's first line, redacted BEFORE it is cut, so a cut can never leave
 * part of a secret behind.
 */
export function cellNote(error, max = 160) {
  return redact(String(error)).split('\n')[0].slice(0, max);
}

/**
 * Puts a theme on a fresh context: its cookies, and its localStorage written by an init script so
 * it is in place before the page's own theme script reads it, on every navigation. `colorScheme`
 * is set when the context is created.
 */
export async function applyTheme(context, theme, base) {
  if (!theme) return;
  if (theme.cookies?.length)
    await context.addCookies(
      theme.cookies.map((c) => ({ name: c.name, value: c.value, url: base })),
    );
  if (theme.storage)
    await context.addInitScript((items) => {
      try {
        for (const [k, v] of Object.entries(items))
          window.localStorage.setItem(k, v);
      } catch {
        // about:blank and opaque origins have no storage; the next navigation sets it.
      }
    }, theme.storage);
}

/**
 * Fails the cell when the page did not draw the asked-for theme: an app that ignores the cookie or
 * key, or overrides it after load (a signed-in user's saved theme), would otherwise photograph its
 * default under this theme's name.
 */
export async function checkTheme(page, theme) {
  if (!theme?.dataTheme) return;
  const drawn = await page.evaluate(
    () => document.documentElement.dataset.theme ?? null,
  );
  if (drawn !== theme.dataTheme)
    throw new Error(
      `theme ${theme.label}: the page drew data-theme="${drawn}", not "${theme.dataTheme}"`,
    );
}

/** What a page still loading shows, unless featureAcceptance.loading names the project's own. */
export const DEFAULT_LOADING = ['[aria-busy="true"]'];

/**
 * Fails the cell when a loading marker is still visible after the row's steps: a cell that
 * photographs a skeleton has no evidence in it, and its wait passing does not make it real.
 */
export async function checkLoaded(page, markers) {
  for (const marker of markers)
    if (
      await page
        .locator(marker)
        .first()
        .isVisible()
        .catch(() => false)
    )
      throw new Error(
        `still loading: ${marker} is visible after the steps; wait for the content`,
      );
}

/**
 * Routes console.log, info, warn and error through `redact` until the returned restore is called:
 * the project's sign-in module and anything it imports print through the same console.
 */
export function redactConsole(target = console) {
  const originals = {};
  for (const level of ['log', 'info', 'warn', 'error']) {
    originals[level] = target[level];
    target[level] = (...args) =>
      originals[level].call(
        target,
        ...args.map((a) =>
          typeof a === 'string' ? redact(a) : redact(inspect(a)),
        ),
      );
  }
  return () => Object.assign(target, originals);
}

async function main() {
  // Everything printed goes through redact (see registerSecrets), the project's own output too.
  registerSecretEnv();
  const restore = redactConsole();
  try {
    await photograph();
  } finally {
    restore();
  }
}

async function photograph() {
  const say = (text) => console.log(text);
  const { flags, positional } = parseArgs(process.argv.slice(2), {
    valued: ['root', 'base'],
  });
  const root = projectRoot(flags);
  const inventoryPath = positional[0];
  const inventory = await readInventory(inventoryPath);
  registerSecrets(inventory);
  const cfg = acceptanceConfig(root);

  const base = (
    flags.base ??
    process.env.CONTACT_SHEET_BASE ??
    need(
      cfg,
      'baseUrl',
      'the origin to photograph: the local dev server (http://localhost:3000) before a PR',
    )
  ).replace(/\/$/, '');
  const baseError = baseUrlError(base, { productionUrl: cfg.productionUrl });
  if (baseError) throw new SetupError(baseError);
  // Named on every run and on the sheet, so a sheet of the wrong server (another worktree's dev
  // server on the same port, local when staging was meant) is visible as such.
  say(
    `photographing ${base}${cfg.productionUrl ? '' : ' (no productionUrl set, so production is not refused)'}`,
  );

  const widths =
    inventory.widths ?? need(cfg, 'widths', 'the phone and desktop viewports');
  const widthProblems = widthErrors(
    widths,
    inventory.widths ? 'inventory' : 'featureAcceptance',
  );
  // Optional: every theme is a pass of the whole sheet in a fresh context. None draws the default.
  const themes = inventory.themes ?? cfg.themes;
  const themeProblems =
    themes === undefined
      ? []
      : themeErrors(
          themes,
          inventory.themes ? 'inventory' : 'featureAcceptance',
        );
  const problems = [
    ...widthProblems,
    ...themeProblems,
    ...inventoryErrors(inventory, widths.map?.((w) => w.label) ?? []),
  ];
  if (problems.length)
    throw new SetupError(
      `${inventoryPath} is not runnable:\n  - ${problems.join('\n  - ')}`,
    );
  const scope = cfg.pageScope ?? 'main';
  const loading = cfg.loading ?? DEFAULT_LOADING;
  if (
    !Array.isArray(loading) ||
    loading.some((m) => typeof m !== 'string' || !m)
  )
    throw new SetupError(
      'featureAcceptance.loading is a list of selectors a page still loading shows ([] for none)',
    );
  let cookies = [];
  try {
    cookies = (inventory.cookies ?? []).map((c) => ({
      name: c.name,
      value: expand(c.value, `cookie ${c.name}`),
      url: base,
    }));
  } catch (error) {
    throw new SetupError(error.message);
  }
  const passes = themes ?? [null];

  // Settled before a browser starts, so a misconfigured project fails in a second, not a minute.
  let signIn = null;
  if (!inventory.signedOut) {
    const rel = need(
      cfg,
      'signIn',
      'a module exporting signIn(page, { baseUrl }); or mark the inventory "signedOut": true',
    );
    const mod = await importProjectFile(root, rel);
    signIn = mod.signIn ?? mod.default;
    if (typeof signIn !== 'function')
      throw new SetupError(
        `${rel} exports no signIn(page, { baseUrl }) function`,
      );
  }
  const { chromium } = await importFromProject(
    root,
    ['playwright', '@playwright/test'],
    'the contact sheet drives a browser',
    cfg.packageDir,
  );

  const name = path.basename(inventoryPath, '.json');
  const outDir = path.resolve(
    root,
    inventory.out ?? path.join(cfg.out ?? 'contact-sheets', name),
  );
  await mkdir(outDir, { recursive: true });

  const shots = [];
  const browser = await chromium.launch();
  try {
    for (const theme of passes)
      for (const size of widths) {
        const context = await browser.newContext({
          viewport: { width: size.width, height: size.height },
          deviceScaleFactor: 1,
          hasTouch: size.touch === true,
          // A service worker answers from its cache and outlives the row; and Playwright cannot
          // see, route or mock what a worker fetches.
          serviceWorkers: 'block',
          ...(theme?.colorScheme ? { colorScheme: theme.colorScheme } : {}),
        });
        if (cookies.length) await context.addCookies(cookies);
        await applyTheme(context, theme, base);
        const page = await context.newPage();
        const where = theme ? `${size.label} · ${theme.label}` : size.label;
        const suffix = theme ? `-${theme.label}` : '';
        // A failed sign-in fails every cell at this width, named, and the run goes on to the next.
        let signInFailed = '';
        if (signIn)
          await Promise.resolve()
            .then(() => signIn(page, { baseUrl: base }))
            .catch((error) => {
              signInFailed = `sign-in failed: ${cellNote(error?.message ?? error, 140)}`;
            });
        for (const row of inventory.rows) {
          // A surface that exists at one width only says so; the other width is not a failed cell.
          if (row.widths && !row.widths.includes(size.label)) {
            say(`· ${row.id} · ${where}: not drawn at this width`);
            continue;
          }
          const file = path.join(
            outDir,
            `${row.id}-${size.label}${suffix}.png`,
          );
          // A shot left by an earlier run must not stand in for a cell that failed this time.
          await rm(file, { force: true });
          let note = signInFailed;
          if (!note)
            try {
              for (const step of row.steps)
                await runStep(page, step, { base, scope });
              await checkTheme(page, theme);
              await checkLoaded(page, loading);
              await page.screenshot({
                path: file,
                fullPage: row.fullPage ?? inventory.fullPage ?? false,
              });
            } catch (error) {
              note = cellNote(error);
              await page.screenshot({ path: file }).catch(() => {});
            }
          // A row that went offline, or mocked a request, must not leave the next one in that state.
          await context.setOffline(false);
          // unrouteAll is Playwright 1.41+, only needed by a row that routed: an older Playwright
          // then stops the run rather than carry one row's mocks into the next.
          if (row.steps.some((s) => s.route !== undefined))
            await page.unrouteAll({ behavior: 'ignoreErrors' });
          shots.push({ label: row.label, size: where, file, note });
          say(
            `${note ? '✗' : '✓'} ${row.id} · ${where}${note ? `: ${note}` : ''}`,
          );
        }
        await context.close();
      }

    // The sheet: a page of the photographs, screenshotted. No image library to install.
    const sheetPage = await (
      await browser.newContext({ viewport: { width: 1800, height: 1200 } })
    ).newPage();
    const withData = await Promise.all(
      shots.map(async (s) => ({
        ...s,
        data: await readFile(s.file)
          .then((b) => b.toString('base64'))
          .catch(() => null),
      })),
    );
    await sheetPage.setContent(sheetHtml(inventory.feature, withData, base));
    await sheetPage.waitForTimeout(600);
    const sheet = path.join(outDir, 'sheet.png');
    await sheetPage.screenshot({ path: sheet, fullPage: true });
    say(`\nsheet: ${sheet}`);
  } finally {
    await browser.close();
  }

  // The backstop: a run that photographed nothing is a silent success whatever caused it.
  if (shots.length === 0) {
    say(
      '\nNOTHING WAS PHOTOGRAPHED. A sheet with no cells is not coverage: check rows and widths.',
    );
    process.exitCode = 1;
  }
  const failed = shots.filter((s) => s.note);
  if (failed.length) {
    say(
      `\n${failed.length} of ${shots.length} cells did not reach their surface. Those cells have no evidence in them.`,
    );
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) await runTool('contact-sheet', main);
