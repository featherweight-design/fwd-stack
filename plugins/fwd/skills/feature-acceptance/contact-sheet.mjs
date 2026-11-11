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

import { isMain } from '../../lib/is-main.mjs';
import {
  baseUrlError,
  expand,
  inventoryErrors,
  sheetHtml,
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
  if (step.goto !== undefined) {
    const asked = new URL(`${base}${expand(step.goto, 'goto', env)}`);
    const response = await page.goto(asked.href, {
      waitUntil: 'domcontentloaded',
    });
    // An error page is a reached cell showing nothing: fail it rather than photograph it.
    if (response && response.status() >= 400)
      throw new Error(`goto ${step.goto}: HTTP ${response.status()}`);
    // So is a redirect: to sign-in, to home, to another origin. Write the goto as the final path.
    const landed = new URL(page.url());
    const trim = (p) => p.replace(/(.)\/$/, '$1');
    if (
      landed.origin !== asked.origin ||
      trim(landed.pathname) !== trim(asked.pathname)
    )
      throw new Error(
        `goto ${step.goto} landed on ${landed.origin === asked.origin ? landed.pathname : landed.origin + landed.pathname}`,
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
  if (step.waitDialog !== undefined)
    await page
      .getByRole('dialog', { name: step.waitDialog, exact: true })
      .first()
      .waitFor({ state: 'visible', timeout: T });
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

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2), {
    valued: ['root', 'base'],
  });
  const root = projectRoot(flags);
  const inventoryPath = positional[0];
  const inventory = await readInventory(inventoryPath);
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

  const widths =
    inventory.widths ?? need(cfg, 'widths', 'the phone and desktop viewports');
  const widthProblems = widthErrors(
    widths,
    inventory.widths ? 'inventory' : 'featureAcceptance',
  );
  const problems = [
    ...widthProblems,
    ...inventoryErrors(inventory, widths.map?.((w) => w.label) ?? []),
  ];
  if (problems.length)
    throw new SetupError(
      `${inventoryPath} is not runnable:\n  - ${problems.join('\n  - ')}`,
    );
  const scope = cfg.pageScope ?? 'main';
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
    for (const size of widths) {
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        deviceScaleFactor: 1,
        hasTouch: size.touch === true,
      });
      if (cookies.length) await context.addCookies(cookies);
      const page = await context.newPage();
      // A failed sign-in fails every cell at this width, named, and the run goes on to the next.
      let signInFailed = '';
      if (signIn)
        await Promise.resolve()
          .then(() => signIn(page, { baseUrl: base }))
          .catch((error) => {
            signInFailed = `sign-in failed: ${String(error?.message ?? error)
              .split('\n')[0]
              .slice(0, 140)}`;
          });
      for (const row of inventory.rows) {
        // A surface that exists at one width only says so; the other width is not a failed cell.
        if (row.widths && !row.widths.includes(size.label)) {
          console.log(`· ${row.id} · ${size.label}: not drawn at this width`);
          continue;
        }
        const file = path.join(outDir, `${row.id}-${size.label}.png`);
        // A shot left by an earlier run must not stand in for a cell that failed this time.
        await rm(file, { force: true });
        let note = signInFailed;
        if (!note)
          try {
            for (const step of row.steps)
              await runStep(page, step, { base, scope });
            await page.screenshot({
              path: file,
              fullPage: row.fullPage ?? inventory.fullPage ?? false,
            });
          } catch (error) {
            note = String(error).split('\n')[0].slice(0, 160);
            await page.screenshot({ path: file }).catch(() => {});
          }
        // A row that went offline must not leave the next one photographing an offline app.
        await context.setOffline(false);
        shots.push({ label: row.label, size: size.label, file, note });
        console.log(
          `${note ? '✗' : '✓'} ${row.id} · ${size.label}${note ? `: ${note}` : ''}`,
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
    await sheetPage.setContent(sheetHtml(inventory.feature, withData));
    await sheetPage.waitForTimeout(600);
    const sheet = path.join(outDir, 'sheet.png');
    await sheetPage.screenshot({ path: sheet, fullPage: true });
    console.log(`\nsheet: ${sheet}`);
  } finally {
    await browser.close();
  }

  // The backstop: a run that photographed nothing is a silent success whatever caused it.
  if (shots.length === 0) {
    console.log(
      '\nNOTHING WAS PHOTOGRAPHED. A sheet with no cells is not coverage: check rows and widths.',
    );
    process.exitCode = 1;
  }
  const failed = shots.filter((s) => s.note);
  if (failed.length) {
    console.log(
      `\n${failed.length} of ${shots.length} cells did not reach their surface. Those cells have no evidence in them.`,
    );
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) await runTool('contact-sheet', main);
