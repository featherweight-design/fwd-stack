#!/usr/bin/env node
// The probe runner: one claim about how a screen behaves, pressed and measured in a real engine at
// every width, with a PASS or FAIL line for each check and a non-zero exit when any fails.
//
// A screenshot shows what a screen looks like at rest. A probe proves what it does when pressed:
// that a tap on a ✕ empties the field and keeps focus, that a sheet's footer clears the fold, that
// a pinned header stays pinned after a scroll. The project writes the probe (one small module per
// claim); this runner owns the setup every probe would otherwise copy: the project's widths and
// sign-in, the production refusal, touch at phone width, the page scope and the report.
//
//   node ~/.claude/fwd/skills/ui-probe/probe.mjs <probe.mjs> [--base <url>] [--expect-fail]
//
// `--expect-fail` is the mutation run: with the fix reverted, the probe must fail, so the run exits
// 0 only when at least one check failed. A probe that still passes there proves nothing.
//
// Reads `featureAcceptance` from `.claude/fwd.json`, as the contact sheet does: baseUrl,
// productionUrl, widths (touch: true on the phone), signIn, pageScope, packageDir.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { isMain } from '../../lib/is-main.mjs';
import {
  DEFAULT_LOADING,
  redactConsole,
  runStep,
} from '../feature-acceptance/contact-sheet.mjs';
import {
  baseUrlError,
  registerSecretEnv,
  widthErrors,
} from '../feature-acceptance/inventory.mjs';
import {
  acceptanceConfig,
  importFromProject,
  importProjectFile,
  need,
  parseArgs,
  projectRoot,
  runTool,
  SetupError,
} from '../feature-acceptance/project.mjs';

/** How long goto waits for the page's loading markers to clear. */
export const LOADING_WAIT_MS = 15_000;

/** Wait for every animation running on an element and its subtree, rather than guessing a delay. */
export async function settled(locator) {
  await locator.evaluate((el) =>
    Promise.all(
      el
        .getAnimations({ subtree: true })
        .map((a) => a.finished.catch(() => {})),
    ),
  );
  return locator;
}

/**
 * One real press at the element's centre: a touch tap where the width has touch, a mouse click
 * elsewhere. Not `locator.click()`, which retries until the target stops moving and so hides the
 * very defect where a control moves out from under the finger. Returns the box it pressed.
 */
export async function press(page, locator, { touch }) {
  await locator.waitFor({ state: 'visible' });
  // A box below the fold is off-screen coordinates, and a tap there lands on nothing.
  await locator.scrollIntoViewIfNeeded();
  await settled(locator);
  const box = await locator.boundingBox();
  if (!box) throw new Error('press: the element has no box to press');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (touch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
  return box;
}

/** A PASS or FAIL line per check, counted, so a run is judged by its checks rather than a crash. */
export function createReport(log = console.log) {
  let passed = 0;
  let failed = 0;
  return {
    check(ok, label, saw) {
      if (ok) passed += 1;
      else failed += 1;
      log(
        `${ok ? 'PASS' : 'FAIL'}  ${label}${saw === undefined ? '' : `  (${saw})`}`,
      );
      return ok;
    },
    counts: () => ({ passed, failed }),
  };
}

/**
 * The exit code for a run. A run with no checks proved nothing, in either mode. Normally any failure
 * (or a probe that threw) is 1; under --expect-fail the run passes only when a check failed.
 */
export function verdict(
  { passed, failed, threw },
  { expectFail = false } = {},
) {
  if (passed + failed === 0 && !threw)
    return {
      code: 1,
      note: 'NO CHECKS RAN. A probe with no checks is not evidence.',
    };
  if (expectFail)
    return failed > 0 && !threw
      ? {
          code: 0,
          note: `mutation run: ${failed} check(s) failed, as they must with the fix reverted`,
        }
      : {
          code: 1,
          // A crash at one width can sit beside a failed check at another; neither is the fix.
          note: threw
            ? 'mutation run: the probe crashed, so it shows nothing about the fix'
            : 'mutation run: every check passed with the fix reverted, so the probe does not test the fix',
        };
  if (threw || failed > 0)
    return {
      code: 1,
      note: `${failed} check(s) failed${threw ? ', and the probe threw' : ''}`,
    };
  return { code: 0, note: `${passed} check(s) passed` };
}

/** The widths a probe runs at: every configured width, or the labels its `widths` export names. */
export function pickWidths(configured, only) {
  if (only === undefined) return configured;
  if (!Array.isArray(only) || only.length === 0)
    throw new SetupError(
      'a probe\'s `widths` export lists width labels, e.g. ["phone"]',
    );
  const unknown = only.filter((l) => !configured.some((w) => w.label === l));
  if (unknown.length)
    throw new SetupError(
      `the probe names width(s) ${unknown.join(', ')}; featureAcceptance.widths has ${configured.map((w) => w.label).join(', ')}`,
    );
  return configured.filter((w) => only.includes(w.label));
}

async function main() {
  // Everything printed goes through redact: sign-in errors and page text can carry a credential.
  registerSecretEnv();
  const restore = redactConsole();
  try {
    await run();
  } finally {
    restore();
  }
}

async function run() {
  const { flags, positional } = parseArgs(process.argv.slice(2), {
    valued: ['base', 'root'],
    switches: ['expect-fail'],
  });
  if (positional.length !== 1)
    throw new SetupError(
      'usage: probe.mjs <probe.mjs> [--base <url>] [--expect-fail]',
    );
  const root = projectRoot(flags);
  const cfg = acceptanceConfig(root);
  const base = (
    flags.base ??
    process.env.PROBE_BASE ??
    need(
      cfg,
      'baseUrl',
      'the origin to probe: the local dev server before a PR',
    )
  ).replace(/\/$/, '');
  const baseError = baseUrlError(base, { productionUrl: cfg.productionUrl });
  if (baseError) throw new SetupError(baseError);
  if (!cfg.productionUrl)
    console.log('no productionUrl set, so production is not refused');

  const probeFile = path.resolve(positional[0]);
  const mod = await import(pathToFileURL(probeFile).href).catch((error) => {
    throw new SetupError(`${positional[0]} did not load: ${error.message}`);
  });
  const probe = mod.default ?? mod.probe;
  if (typeof probe !== 'function')
    throw new SetupError(
      `${positional[0]} exports no default probe({ page, check, … }) function`,
    );

  const configured = need(cfg, 'widths', 'the phone and desktop viewports');
  const problems = widthErrors(configured, 'featureAcceptance');
  if (problems.length) throw new SetupError(problems.join('\n  - '));
  const widths = pickWidths(configured, mod.widths);

  let signIn = null;
  if (!mod.signedOut) {
    const rel = need(
      cfg,
      'signIn',
      'a module exporting signIn(page, { baseUrl }); or export signedOut = true',
    );
    const signInMod = await importProjectFile(root, rel);
    signIn = signInMod.signIn ?? signInMod.default;
    if (typeof signIn !== 'function')
      throw new SetupError(
        `${rel} exports no signIn(page, { baseUrl }) function`,
      );
  }
  const { chromium } = await importFromProject(
    root,
    ['playwright', '@playwright/test'],
    'a probe drives a browser',
    cfg.packageDir,
  );
  const scope = cfg.pageScope ?? 'main';
  const loading = cfg.loading ?? DEFAULT_LOADING;

  console.log(
    `probing ${base} with ${path.relative(root, probeFile)}${flags['expect-fail'] ? ' (mutation run)' : ''}`,
  );
  const report = createReport();
  let threw = false;
  const browser = await chromium.launch().catch((error) => {
    throw new SetupError(
      `the browser did not start (is Chromium installed? npx playwright install chromium): ${error.message}`,
    );
  });
  try {
    for (const width of widths) {
      const touch = width.touch === true;
      const context = await browser.newContext({
        viewport: { width: width.width, height: width.height },
        hasTouch: touch,
        // A touch width is a phone: mobile viewport handling and touch events, as a phone has.
        isMobile: touch,
        serviceWorkers: 'block',
      });
      try {
        const page = await context.newPage();
        if (signIn) await signIn(page, { baseUrl: base });
        const at = (label) => `${width.label}: ${label}`;
        const onPage = (selector) =>
          scope
            ? page.locator(scope).locator(selector)
            : page.locator(selector);
        await probe({
          page,
          base,
          width,
          touch,
          onPage,
          onPageRole: (role, name) =>
            (scope ? page.locator(scope) : page).getByRole(role, { name }),
          // The contact sheet's goto: an HTTP error, or landing anywhere but the asked path on the
          // asked origin (a sign-in wall, another origin), throws. Then the page's loading markers
          // must clear, so no probe measures a skeleton.
          goto: async (route, { expectRedirect } = {}) => {
            await runStep(
              page,
              { goto: route, expectRedirect },
              { base, scope },
            );
            for (const marker of loading)
              await page
                .locator(marker)
                .first()
                .waitFor({ state: 'hidden', timeout: LOADING_WAIT_MS });
          },
          press: (locator) => press(page, locator, { touch }),
          settled,
          check: (ok, label, saw) => report.check(ok, at(label), saw),
        });
      } catch (error) {
        threw = true;
        console.log(
          `FAIL  ${width.label}: the probe threw  (${error?.message ?? error})`,
        );
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  const { code, note } = verdict(
    { ...report.counts(), threw },
    { expectFail: flags['expect-fail'] === true },
  );
  console.log(`\n${note}`);
  process.exitCode = code;
}

if (isMain(import.meta.url)) await runTool('probe', main);
