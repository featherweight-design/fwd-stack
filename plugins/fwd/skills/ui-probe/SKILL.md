---
name: ui-probe
description: Use whenever a UI change or UI bug fix claims how a screen behaves — a tap, focus, a scroll, a sheet opening, a pinned header, an overflow, a control's position, a timing — and before calling any such PR done. Defines the probe, a small script that presses the real screen at phone and desktop width and measures what happened, proven by failing with the fix reverted. Screenshots show a screen at rest; probes prove what it does.
---

# ui-probe

**First, read the project's own rules.** If `.claude/fwd/ui-probe.md` exists in the project, read
it before anything else: it names where probes live, the probe catalogue, the sign-in account and
any fixture rules, and its rules add to these and win where they conflict.

## Why this exists

A screenshot is a still frame of a screen nobody touched. Most UI defects that reach users live
in what happens next: a ✕ that moves out from under the finger, so the first tap does nothing; a
field that loses focus; a sheet footer under the fold; a header that stops being pinned once the
page scrolls; a list that scrolls in its own box on a phone. None of these shows on a contact
sheet, and a reviewer reading a diff cannot see them either. Projects that relied on screenshots
alone shipped these gaps; projects that probed every behavioural claim caught them before review.

So the rule: **every claim about behaviour or geometry ships with a probe, and the probe is shown
to fail with the fix reverted.** The contact sheet (`feature-acceptance`) still proves that every
route at every width has the surface. The probe proves the surface works.

## What a probe is

One module per claim, in the project's probe folder, run by the kit's runner:

```bash
node ~/.claude/fwd/skills/ui-probe/probe.mjs <probe.mjs> [--base <url>] [--expect-fail]
```

The runner reads `featureAcceptance` in `.claude/fwd.json` (the same block the contact sheet
uses): `baseUrl`, `productionUrl`, `widths`, `signIn`, `pageScope` and `packageDir`. Set
`touch: true` on the phone width, so a phone press is a touch tap. The base is `--base`, else
`PROBE_BASE`, else `baseUrl`; every production origin is refused.

```js
// probes/search-clear.mjs: one tap on the search ✕ empties the field and keeps focus.
export default async function ({ goto, onPage, press, check, page }) {
  await goto('/search');
  const input = onPage('[data-search] input');
  await input.fill('zzq');
  const clear = onPage('[data-search] button[aria-label="Clear search"]');
  const before = await press(clear); // one real tap or click at the centre
  await page.waitForTimeout(250);
  check(
    (await input.inputValue()) === '',
    'one press empties the field',
    `value=${await input.inputValue()}`,
  );
  check(
    await input.evaluate((el) => el === document.activeElement),
    'the field keeps focus',
  );
  const after = await clear.boundingBox();
  check(
    !!after && Math.abs(after.x - before.x) < 1,
    'the ✕ holds its box',
    `x ${before.x} to ${after?.x}`,
  );
}
// Optional: export const widths = ['phone']; export const signedOut = true;
```

The probe gets: `page`, `base`, `width`, `touch`, `goto(route)` (fails on an HTTP error),
`onPage(selector)` and `onPageRole(role, name)` (scoped to `pageScope`, so a probe never measures
the app shell's identical control), `press(locator)`, `settled(locator)` and
`check(ok, label, saw)`. It runs once per width in a fresh, signed-in context with service workers
blocked. Each check prints `PASS` or `FAIL` with the width and what it saw. The run exits 1 on any
failed check, a probe that threw, or a run with no checks at all; 2 when it cannot run.

## How to write one

- **One claim, stated in the header comment, as the user would see it.** "One tap empties the
  field and keeps focus", not "test search".
- **Both widths, unless the surface exists at one.** Phone and desktop are different layouts with
  different defects. Export `widths` only for a surface that truly exists at one width.
- **Press like a person.** `press` puts one real tap or click at the element's centre.
  `locator.click()` retries until the target stops moving, which hides the defect where it moves.
- **Measure, then assert a number.** Read the DOM: `boundingBox()`, `document.activeElement`,
  `scrollWidth` against `clientWidth`, `getComputedStyle`, `scrollY`, an accessible name. Print
  what you saw in the check's third argument, so a failure explains itself.
- **Wait for the engine, not a guess.** `settled(locator)` waits for the element's running
  animations; a box read mid-transition is a state nobody sees. Prefer waiting for a condition to
  a fixed delay.
- **Scope to the page.** Use `onPage`; the shell often carries the same roles and labels and comes
  first in the document.
- **Time in the page.** A timing claim stamps `performance.now()` inside the page (a capture
  listener on the press, `requestAnimationFrame` until the result draws) and reads the stamps
  back. The harness's own clock is quantised by its polling.
- **Never print a secret.** A check's `saw` is page text; keep tokens, invite codes and emails out
  of it.

## Prove it fails

A probe written by the author of the fix asserts what the author believed. It earns trust by
failing without the fix:

1. Revert the fix (or apply the smallest change that reintroduces the defect) in the working tree.
2. Run with `--expect-fail`. It exits 0 only when at least one check fails; a probe that passes
   here does not test the fix, and one that crashes shows nothing.
3. Restore the fix and run normally: every check passes.
4. Record both in the PR body under `## Probes`: the command, the mutation, which checks failed,
   and the clean run.

## Where probes live

- One file per claim in the project's probe folder, named for the claim.
- **A catalogue entry per probe** in the project's probe catalogue (named in
  `.claude/fwd/ui-probe.md`): what it proves, why it needs an engine, what data it needs, and the
  mutation that fails it. A probe nobody can find is re-written by the next agent.
- A probe stays after its PR merges. Rerun the probes for a surface whenever it changes, and at the
  feature's close-out walk.

## Safety

- **Never production.** The runner refuses every `productionUrl` origin. Point at the local dev
  server before a PR and staging after merge.
- **Read-only by default.** Most probes sign in, press and measure. A probe that must create data
  writes only rows it owns (a per-run fixture) and deletes them in a `finally`; one that wipes or
  reseeds an account runs only on a scratch database the project names, never a shared one.
- **No spend.** A probe that presses something backed by a paid model or API runs against a stub,
  and the project's rules say how to prove the stub is on before the first press.

## When it runs

- **Per PR:** every behavioural or geometric claim in the PR has a probe that fails with the fix
  reverted and passes with it. A UI bug fix starts by writing the probe that fails on the bug.
- **On a `ui-audit` finding:** the finding becomes a probe first; the fix is done when the probe
  passes.
- **At feature close:** rerun every probe for the feature's surfaces with the contact sheet.

## Red flags

| Thought                                    | Reality                                                           |
| ------------------------------------------ | ----------------------------------------------------------------- |
| "The screenshot looks right"               | A screenshot is the screen at rest. Press it.                     |
| "The probe passes"                         | Does it fail with the fix reverted? Until then it proves nothing. |
| "Desktop is enough, the phone is the same" | Different layout, different input. Both widths.                   |
| "I'll use locator.click()"                 | It waits for the target to stop moving. Use `press`.              |
| "I'll wait 500ms for the sheet"            | Use `settled`; a guess is a flaky probe.                          |
| "The unit test covers it"                  | jsdom has no layout, no focus loss on tap and no scrolling.       |
| "I'll write a new runner for this probe"   | The runner exists. Add a probe module, never another harness.     |
