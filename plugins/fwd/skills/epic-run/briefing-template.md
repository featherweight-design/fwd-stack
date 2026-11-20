# Epic Run Briefing — <epic name>

> Template for `docs/superpowers/plans/YYYY-MM-DD-<epic>-briefing.md`. Fill every
> section; delete none. The briefing carries the feature-specific facts the
> epic-run skill needs — run mechanics live in the skill, not here. Keep under
> ~600 lines (a review reads a file whole only up to about this size).

## Source of truth (read in this order)

1. `docs/superpowers/plans/<execution-plan>.md` — master sequencing: phases, PR count, gates. Follow its order exactly.
2. Eng spec issue/doc — scope, including anything absorbed from other issues.
3. Merged design briefs in `docs/superpowers/specs/` (list each with issue #).
4. Design handoffs in `design/design_handoff_<...>/` — visual ground truth for pixel-perfect.

## Current state (verified YYYY-MM-DD)

Only claims verified on the stated date, with enough detail to re-verify at
kickoff. Cover: env vars (name, environment scope, where placed, how verified; never the
values themselves, since this file is committed), external
accounts/services (live? configured?), things that intentionally do NOT exist
yet (and when they get created), known anomalies to ignore (e.g. intentionally
paused services).

## Risk shape — REQUIRED

One of **event-driven**, **content/data-driven**, or **copy/IA-driven** (or a named mix),
plus two sentences on where this epic's bugs will actually come from. The skill's "Which
gates fire when" section scopes effort off this. Getting it wrong means a night spent
forcing loading states on a static page while a notification silently never fires.

## Launch gating — REQUIRED

When does this vertical become reachable by a real user, and what exactly flips it?

State one of: (a) reachable on merge, deliberately — with the reason it is safe at the
product's current launch stage; (b) gated behind a named flag/env var, with its default, where
it is set per environment, and which PR introduces the gate; (c) dark until a runbook step,
with the step named. **"Not applicable" is only true if no PR in this plan makes anything
newly reachable to an end user** — say so explicitly rather than deleting the section.

Also name the PR that makes the vertical live, and whether any changelog or release-note
entry must be held back until the gate opens.

> One epic shipped without this section and made a not-yet-launched app publicly browsable
> the moment its last PR merged. Retro-fixed by a later PR. Absence of a launch decision is not a
> decision that there is no launch.

## Off-happy-path homes — REQUIRED

For every new state this feature can put a user or record into, name the surface where it
lives and how the user gets back to it. One row per state.

| New state | Where it lives in the IA | How the user reaches it | Reversible? |
| --------- | ------------------------ | ----------------------- | ----------- |

Include the states created by _partial_ use — someone who starts the journey and stops
halfway, or who does one half of a two-part action. Any row you cannot fill is a product
question: escalate it before PR-1, do not invent an answer.

> One epic added a second, independent status alongside an existing one and shipped with no
> home for a user holding the new status without the old one. Nobody had asked the question.

## User journeys — walk script — REQUIRED

The numbered, imperative script the run walks itself mid-run (Gate 5 + the cold-eyes
capture) and that the user walks after the run. Written **before** the build, so their pass is
verification and not discovery. Each journey needs its reverse and repeat spelled out.

For each journey: the entry point, the numbered forward steps with the expected state after
each, the undo path, what a repeat should do, and what surviving a reload should look like.
Name any journey that cannot be exercised on local dev and say where it gets walked instead.

## Hard pause points — stop and ask, do not proceed

Feature-specific stops beyond the skill's defaults (prod DB migrations,
unresolved ambiguity). Example: fields that must stay NULL until launch day.

## Notify-and-proceed

Actions that would otherwise feel pause-worthy but should not block, each with:
the safe-mode validation to run first, the evidence to capture, and why
proceeding is acceptable (e.g. no active customers yet).

## Done means

Concrete, checkable completion criteria for THIS epic: which phases through
which validation, dormant-but-built mechanisms, runbook steps to document.
