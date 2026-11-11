---
name: feature-acceptance
description: Use when a UI feature is finished — before calling any PR done and again before closing out a multi-PR feature line. Defines the acceptance artifacts (route×viewport contact sheet, cross-route sameness checks, the route inventory) that prove a feature actually landed on every surface it claimed. Complements pr-review, which governs the review loop; this governs whether the work is right.
---

# feature-acceptance

**First, read the project's own rules, and stop if they are missing.** Read
`.claude/fwd/feature-acceptance.md` in the project before anything else: it names the project's
widths, inventory folder, sign-in and conventions, and its rules add to these and win where they
conflict. **If that file does not exist, stop.** Do not skip the artifacts, and do not call the
PR done. Tell the orchestrator (or the user, when there is none) in one message:
"feature-acceptance is not set up in this project: no `.claude/fwd/feature-acceptance.md`. The UI
work is unaccepted until it is." A project without the file used to get no checks at all,
silently, and its UI shipped with gaps the checks below exist to catch. Setting the project up is
its own small task (§ The project file); it needs the user's yes like any other.

The file either points at the kit's tools below, and then `.claude/fwd.json` carries the
`featureAcceptance` block they read (they refuse to run without it), or names the project's own
tools for the same four artifacts. Either way, an artifact the file does not provide for is a stop
and a report, never a skip.

`pr-review` governs the review loop — whether the code was read. This governs
whether the feature is **there**. They are different questions and they fail
independently.

## Why this exists

One feature line, illustratively: five PRs, dozens of review rounds, dozens of
findings, more than a day of PR lifetime. Then the user opened the app and found three gaps in a few minutes:

- two of the three routes the feature claimed didn't show the new control;
- a fourth route was right on desktop and wrong on the phone;
- the phone treatment didn't reuse the component another route already had.

None of the review findings was any of these, and that is structural rather than bad
luck. **A code review reads a diff. None of these three gaps exists in a diff:**

| Gap                              | Why a diff can't show it                                    |
| -------------------------------- | ----------------------------------------------------------- |
| A route didn't get the component | An absence. The diff shows what was added, not what wasn't. |
| Mobile differs from desktop      | Both halves are individually plausible.                     |
| "Same as route X"                | Sameness lives _between_ files, in different PRs.           |

Worse, each of the five PRs passed its own gate. Every gap was at a seam between
them. **A per-PR gate cannot accept a feature.**

And beware the check that passes for the wrong reason: on that feature, the two
"missing" routes did mount a component, which itself wrapped the shared
primitive. Every structural check of the form _does this route use the chassis_
returned yes, the PR description was literally true, and the routes still didn't
look alike. A per-route reimplementation wearing the shared component's name
defeats every check except looking.

## The four artifacts

A UI feature is not done until these exist. They are cheap — the whole set is
minutes — and they are the only things that catch the class of failure above.

### 1 · The route inventory

The **plan** carries a table of every route × viewport the feature touches,
written before implementation starts. Not "mounts the chassis" — a row per
surface:

| Route       | 390px | 1300px | Shares with |
| ----------- | ----- | ------ | ----------- |
| `/projects` | ☐     | ☐      | — (origin)  |
| `/teams`    | ☐     | ☐      | `/projects` |
| `/search`   | ☐     | ☐      | `/projects` |
| `/archive`  | ☐     | ☐      | `/projects` |

(Use the project's own phone and desktop widths as the column headers.)

Close-out ticks each cell against the **running app**, not against a diff. A row
that was never loaded is not done, however green its PR was.

The inventory is also the input to artifacts 2 and 3 — write it once, and the
checks read it.

### 2 · The contact sheet

One script — **not one per feature** — that loads every route in the inventory at
both viewports and lays the shots out as a single image. No assertions about the
pixels. No baselines. Nothing to approve or maintain. It gets attached to the PR
and to the close-out.

This is the artifact that catches "that route doesn't have it" and "the phone is
wrong" in one glance, because that is exactly how a human catches them.

**It must be a separate script from the feature's own probe.** A probe is written
by the same agent that wrote the code, so it asserts what that agent believed —
on the motivating feature, one PR's probe absorbed several rounds of review
findings and still measured the wrong route. A contact sheet has no beliefs; it just shows the page.

**The kit's contact sheet** walks one inventory (§ The inventory) at every width the project
names and writes `sheet.png` plus one PNG per cell:

```bash
node ~/.claude/fwd/skills/feature-acceptance/contact-sheet.mjs <inventory.json> [--base <url>]
```

It photographs a **deployed** build (staging or a preview: `--base`, else `CONTACT_SHEET_BASE`,
else `featureAcceptance.baseUrl`) and refuses a local address: a local build is not what users get.
A cell fails on a step that finds nothing, an HTTP error, a redirect away from the asked path (a
sign-in wall, a home fallback) or a `back` with nowhere to go. It exits 1 when any cell did not
reach its surface or nothing was photographed, and 2 when it cannot run (no project setup, a
malformed inventory, an unknown flag, Playwright missing). Adding a feature means
adding an inventory, never another script.

**Phone and desktop parity is proven here, not asserted.** Every row runs at every width unless
the row says it exists at one width only. A PR that ships a surface on one width and not the other
shows it on the sheet; "parity ships in the same PR" is checked by looking at both columns.

### 3 · Cross-route sameness, checked two ways

Whenever a brief says one surface matches another, "looks the same" is not the
requirement — **a shared component is**, or they drift again next round.

- **Import equality.** Does the route import and _use_ the same component the
  origin route does? Static, seconds to run, and the only check that catches a
  per-route copy wearing the shared name.
- **Marker presence.** Every route in the inventory renders the shared
  component's marker at both widths. Absence fails.

Both are deterministic and neither has a baseline to maintain.

**Point the check at a leaf, not at a composed primitive.** A component that
takes its controls as props is _meant_ to be assembled by a route-level wrapper;
requiring every route to import it directly reports correct composition as
failure. On the motivating feature that produced false reports on several routes. Ask
what a route renders as-is, and check that.

**The kit's import-equality check** reads the `shares` block on the same inventory:

```bash
node ~/.claude/fwd/skills/feature-acceptance/check-shared.mjs <inventory.json>
```

Each row's `view` must import the named `binding` as a value from the named `module` and reference
it. A route's own wrapper, a constant or type taken from the module, a default or namespace import,
or an unused import all fail. Absent a `shares` block it does nothing, which is the right state
while the shared component is still being identified. Marker presence is the contact sheet's
`wait` on the shared component's marker at every width.

### The token guard

Run on every UI PR, alongside the contact sheet:

```bash
node ~/.claude/fwd/skills/feature-acceptance/check-tokens.mjs [--strict-hex]
```

It fails on any `var(--x)` no theme file declares (an unset custom property draws nothing and
reports nothing, so a typo'd token ships as a void), and reports hard-coded hex colours in the
component folders the project names. A hex colour is drift from the design system; it fails the
run when `tokens.hexFails` is set or with `--strict-hex`. A deliberate one (a brand mark) carries
`fwd-allow-hex` on its line.

### 4 · The close-out walk

Run **once, at the end of the feature line, against the brief** — not per PR.
Per-PR it reads a slice and confirms the slice; that is how five green PRs
produced three gaps. Load every row of the inventory in a real browser, compare
against the brief, and record what you saw.

This is when the `design-review` skill runs against the whole brief.

## The project file

A project on the kit's tools provides two things, and the tools refuse to run without them.

**`.claude/fwd/feature-acceptance.md`** (prose, for agents): the phone and desktop widths in
words, where inventories live, how the sign-in account is provisioned (names of the environment
variables, never values), which component folders the token guard covers, anything about the app
shell a step must avoid, and where the contact sheet goes in a PR.

**`featureAcceptance` in `.claude/fwd.json`** (read by the tools):

| Field             | Required by                 | Meaning                                                                                                                             |
| ----------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`         | contact sheet               | The deployed https origin to photograph (staging). `--base` or `CONTACT_SHEET_BASE` override it.                                    |
| `widths`          | contact sheet               | `[{ "label": "phone", "width": 390, "height": 844 }, { "label": "desktop", "width": 1300, "height": 900 }]`; `touch: true` optional |
| `signIn`          | contact sheet               | Project-relative module exporting `signIn(page, { baseUrl })`; throws on failure. Unneeded if every inventory is `signedOut`.       |
| `pageScope`       | contact sheet               | Selector page content lives in (default `main`), so a step never matches the app shell. `""` for none.                              |
| `inventories`     | agents                      | Folder of inventory JSON files, e.g. `docs/superpowers/inventories`.                                                                |
| `out`             | contact sheet               | Output folder (default `contact-sheets`, gitignore it). One subfolder per inventory.                                                |
| `packageDir`      | contact sheet, check-shared | Folder whose `node_modules` has Playwright and TypeScript (a monorepo's app). Default: the root.                                    |
| `aliases`         | check-shared                | Import aliases to project-relative folders, e.g. `{ "@/": "src/" }`.                                                                |
| `tokens.declare`  | check-tokens                | Globs of theme files; every `--x:` there is declared for the whole app.                                                             |
| `tokens.read`     | check-tokens                | Globs whose `var(--x)` reads must resolve (test files are skipped).                                                                 |
| `tokens.hex`      | check-tokens                | Globs of component folders to report hex colours in.                                                                                |
| `tokens.hexFails` | check-tokens                | `true` to fail on a hex colour rather than report it.                                                                               |

The project installs Playwright (and its Chromium) and TypeScript itself; the kit adds no
dependency. The sign-in module reads its credentials from the environment and never prints them.

## The inventory

One JSON file per feature, in the project's inventory folder. The contact sheet and check-shared
both validate it, and refuse it rather than run part of it.

```json
{
  "feature": "Projects toolbar",
  "signedOut": false,
  "shares": { "binding": "Toolbar", "module": "src/components/ui/toolbar" },
  "rows": [
    {
      "id": "projects",
      "label": "/projects, toolbar at rest",
      "view": "src/app/projects/view.tsx",
      "steps": [
        { "goto": "/projects", "wait": "[data-toolbar]", "settle": 500 }
      ]
    },
    {
      "id": "projects-filter",
      "label": "/projects, filter sheet open",
      "view": "src/app/projects/view.tsx",
      "widths": ["phone"],
      "steps": [
        { "goto": "/projects", "wait": "[data-toolbar]" },
        { "clickRole": "button", "name": "^Filter" },
        { "waitDialog": "Filters" }
      ]
    }
  ]
}
```

- **Top level:** `feature` (required, the sheet's title), `rows` (required, non-empty), and
  optionally `note`, `out`, `signedOut` (photograph with no sign-in), `fullPage`, `widths` (replaces
  the project's for this inventory), `cookies` (`[{ "name", "value" }]`), `shares`.
- **A row:** `id` (lowercase, dashes; names the file), `label` (what the cell shows), `steps`
  (non-empty, the first with a `goto`: rows share one page per width, so a row that does not load
  its own route photographs what the last row left), and optionally `view`, `binding`, `widths` (the labels it exists at; the others are
  skipped, not failed), `fullPage`.
- **Steps** are objects of verbs, run in this order within a step: `goto` (a path), `store`
  (localStorage), `click`, `clickRole` + `name` (a regex), `fill` + `text`, `wait`, `waitDialog` (a
  dialog's accessible name), `hover`, `back`, `offline`, `pressKey`, `settle` (ms), `scrollTo`,
  `scroll` (pixels or `"bottom"`). Put verbs that must run in another order in separate steps.
  Selectors are scoped to `pageScope`; `waitDialog` is not, since dialogs portal outside it. An
  unknown verb is an error, never a step that silently does nothing.
- `${VAR}` in `goto`, `text`, `name` and cookie values comes from the environment, so no inventory
  commits one account's ids. A missing variable fails the cell.
- **`shares`** is `{ "binding", "module" }` or an array of them. With it, every row names its
  `view`; with an array, every row also names its `binding`. `module` names the component used
  as-is, and `view` the file that imports it, which may be a route-level wrapper.
- Give every `goto` a `wait` naming something the finished page has: `settle` is a delay, not a
  readiness check, and a sheet of loading skeletons reads as coverage.
- There is no optional step. A step that finds nothing fails the cell, which is the point of it.

## Do not add pixel-diff visual regression

It is the obvious-looking answer and it is wrong for this class of bug.

- **A pixel diff fires on change, not on absence.** A route that was supposed to
  change and didn't produces an empty diff — indistinguishable from passing. The
  most common gap is exactly the one it cannot see.
- **It cannot express "should match route X."** That is a comparison between two
  routes, not between a route and its own past.
- **Baselines are flaky in any app with themes, art-driven backgrounds or live
  data**, and approving them costs more than reading them.

A contact sheet plus the two structural checks covers what matters, with nothing
to maintain.

## Sequencing

- **Before implementation:** the inventory goes in the plan.
- **Per PR:** the contact sheet for the routes that PR touches, in the PR body.
  Marker presence, import equality and the token guard pass. The `design-review`
  verify table is in the PR body under `## Design review`.
- **At feature close:** full inventory walked, full contact sheet, `design-review`
  against the brief, and every row ticked.
- **Not done** until the last of those is true, whatever the PRs' review state.

## Budget

This is not extra work laid on top of the review loop — it is where the review
loop's savings go. Under `pr-review`'s round limits, a feature line like the one
above needs a fraction of the rounds it took, and the hours returned are far more
than the artifacts cost. One of those hours spent on the artifacts above would
have caught all three gaps before the user did.

## Red flags

| Thought                                 | Reality                                                       |
| --------------------------------------- | ------------------------------------------------------------- |
| "The PR says all three routes mount it" | A description is not a route. Load them.                      |
| "The probe passes"                      | The probe asserts what its author believed. Look at the page. |
| "Each PR passed review"                 | Every gap in the motivating case was at a seam between PRs.   |
| "It uses the shared component"          | Wrapped or reimplemented? Check the import.                   |
| "Desktop looks right"                   | Both viewports, every route, or the row isn't ticked.         |
| "I'll walk it after the last PR merges" | That walk is part of the feature. Unwalked is unfinished.     |
| "We should add screenshot baselines"    | They fire on change, not absence. See above.                  |
| "This project has no acceptance file"   | Stop and report it. Missing setup is not a pass.              |
| "I'll run the sheet against localhost"  | Users get the deployed build. Point it at staging.            |
