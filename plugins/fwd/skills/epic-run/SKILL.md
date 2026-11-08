---
name: epic-run
description: Use when executing a large multi-PR feature epic end-to-end from a merged execution plan, when asked to "run" an epic autonomously through staging validation, or when resuming such a run in a fresh session.
---

# epic-run

**First, read the project's own rules.** If `.claude/fwd/epic-run.md` exists in the project, read
it before anything else: it names the project's own tools and conventions for this skill, and
its rules add to these and win where they conflict.

## Overview

Orchestrates an autonomous multi-PR feature build from a merged execution plan through staging-validated completion. The orchestrating session owns every review cycle end-to-end; subagents only build. Feature-specific facts live in a briefing file — this skill owns only the run mechanics.

CLAUDE.md conventions apply in full (worktrees, code rules, commit style). Read it first; this skill does not restate it.

## When to Use

- A feature epic has a merged execution plan and you're asked to build it (multiple PRs, minimal check-ins)
- A fresh session is resuming an in-flight epic run

**Not for:** single-PR features (use complete-and-ship), design-track work (design persona owns the pipeline), authoring the eng spec or execution plan — those happen upstream, before this skill is invoked.

## Pipeline Position

epic-run is stage 3 of 3. It never authors stages 1–2; it gates on their outputs.

1. **Design persona** → design briefs + handoffs + READINESS verdicts
2. **Eng session (normal)** → spec and execution plan in one PR (superpowers:brainstorming → superpowers:writing-plans), merged at the `pr-review` bar. The plan must name its PR boundaries — no stacked PRs, and nothing over ~20 files or ~800 lines ships as one. **A UI plan must also carry the route × viewport inventory** required by `feature-acceptance`, written before implementation starts; it is the input to every acceptance check and to close-out.
3. **epic-run** → briefing + autonomous multi-PR build through staging validation

## Preconditions Gate — refuse to start if any is missing

1. Eng spec PR merged
2. Execution plan PR merged at the `pr-review` bar, with its PR boundaries named
3. UI in scope → design handoffs exist with READINESS verdicts
4. Briefing file exists at `docs/superpowers/plans/YYYY-MM-DD-<epic>-briefing.md`
5. **Three premise questions answered in writing** (plan or briefing), because all three
   are premise-level and escape every PR-stage gate:
   - **Launch gating** — when does this vertical become reachable, and what flips it? A plan
     whose last PR turns on a vertical needs this decided before PR-1. (One epic made a
     not-yet-launched app publicly browsable the moment its last PR merged; fixed
     retroactively by a later PR.)
   - **Off-happy-path homes** — for every new state the feature can put a user in, where does
     that user _live_ in the IA? (One epic added a second, independent status alongside an
     existing one and shipped with no home for a user holding the new status without the
     old one — an open product question nobody had asked.)
   - **Journey walk script** — the numbered end-to-end script, written before the build. It
     drives Gate 5 and the mid-run capture, and it is what the user walks after the run, so their
     pass is verification rather than discovery.

Missing briefing → interview the user using `briefing-template.md` (in this skill's directory), commit it via its own worktree + PR, then start. Missing a premise answer → resolve it into the briefing (escalate to the user if it's a product call; the off-happy-path question usually is). Missing anything else → stop and report; do not start "while the spec catches up."

## Kickoff (every run AND every fresh-session resume)

1. Read, in order: CLAUDE.md → the run's checkpoint note (wherever the project keeps resume state; the extension names it, and the plan's `## Resume` section is the default) → briefing → execution plan. A resumed session needs nothing from prior chat.
2. **Re-verify every claim in the briefing's Current State section** (env vars placed, external accounts live, feature flags). Check with real commands/MCP tools — a claim verified last week is an assumption today. A stale claim is a blocker to resolve or escalate, not a note.
3. Confirm main repo dir is clean (`git status`); it stays clean for the entire run.

## Run Loop — per PR, in execution-plan order

1. **Worktree:** anchor on the main checkout, not the current directory: `MAIN_REPO="$(git worktree list --porcelain | sed -n '1s/^worktree //p')"`, then `git -C "$MAIN_REPO" fetch origin && git -C "$MAIN_REPO" worktree add "$MAIN_REPO/.worktrees/<branch>" -b <branch> origin/main` (from `origin/main`, never the main checkout's local HEAD, which can lag a predecessor PR that merged remotely) (or the worktree location the extension names), then immediately copy each app's untracked local env file (e.g. `.env.local`) from the main checkout into the worktree at the same relative path — the extension lists which apps have one. Never commit them.
2. **Build:** TDD (superpowers:test-driven-development), writing the tests with the code; they run in CI, never locally (pr-review §5). May delegate to a subagent: implement + write tests + open PR only. Never include review-waiting in a subagent task. Tell each subagent to name its scratch files after its PR or task (`pr<N>-body.md`), never a generic name: subagents in one session share one scratchpad.
3. **Run the gates scoped to this PR's shape (see "Which gates fire when") before `gh pr create`, and read the Recurring Defect Classes list on every UI PR.** Pixel-perfect is the bar. Mobile + desktop parity in the same PR. No UI PR is exempt — animation-only and "visual-only" included.
4. **Pre-push, every push:** typecheck + lint (plus a format check where the project has one) in the worktree, then `git fetch origin && git rebase origin/main`. No tests and no production build locally; CI is the only test gate (pr-review §5). Plain push unless the rebase rewrote commits (then `--force-with-lease`).
5. **Review cycle (orchestrator-owned):** invoke the `pr-review` skill and follow it — request, verify the attach, wait on its watcher (`pr-watch.mjs` via `Monitor`, armed once when the PR opens and re-armed when it times out), check the review is not stale before triaging, fix every valid comment including nits, re-request only where it says a fix earns one, and stop on its bar. The orchestrator — never a subagent — owns the full cycle; the multi-minute wait exceeds a subagent's window.
6. **Merge:** merge it yourself once pr-review's gate allows it (merge bar met, CI green), with the merge method the project uses. No auto-merge flags. Then verify the staging + prod deploy workflows actually ran — some merge paths (for example a merge made through the API rather than the UI) do not trigger them; dispatch manually if so.
7. **Bookkeeping:** the project's release-note or changelog entry for user-facing PRs, any progress log the project keeps (the extension names both), and any follow-up identified collected as a proposal under `backlog-audit`'s intake rule (Step 5): no issue is opened without the user's sign-off, and during an unattended run proposals go into the run report's Proposed intake. Same branch, before merge.
   **Any approved follow-up that needs Design input also needs a tracker row in `docs/superpowers/design-pipeline-status.md` — the label alone loses it.** `design-status` parses that file and never queries issue labels, so a design-labelled ticket with no row is invisible to the pipeline. Judge by the fix, not the label: a missing affordance, a placement call or a new surface is design work even when the ticket reads like a bug or a polish item. Add the row once the follow-up is approved and filed, on the branch then in flight. This step is skipped constantly because the issue _feels_ filed once `gh issue create` returns.
   **Infrastructure the PR depends on must be created, not just declared.** The project's hosting config (e.g. `render.yaml`, `vercel.json`) may be descriptive only — editing it does not necessarily create anything. If a PR adds a cron job, worker, queue, bucket or DB, provision it for real (the provider's MCP tools, CLI or dashboard) in _both_ staging and prod before calling the PR done. Where you genuinely can't — MCP can't home a service to an environment, a secret is the user's to paste — create what you can and carry the gap into the run report's infra table as `⚠️ declared only`. A cron that was never created is the worst failure shape there is: it logs nothing, errors nothing, pages nobody, and the feature silently never runs.
8. **Checkpoint:** update the run's checkpoint note with exact state + next step, confirm main repo dir clean, compact.

Validate on the real staging URL after each deployed phase — CI green is not staging validation.

## Mid-Run Cold-Eyes Review — mandatory, and never blocking

**Trigger:** the moment the first complete user journey is reachable end-to-end — typically
after ~half the UI PRs, and never later than the second-to-last UI PR. Do not defer to the
end of the run.

**Why:** one epic shipped every PR before anyone looked at the vertical whole; the walk then
produced a long list of bugs and several cleanup PRs, and the next epic did the same.
Several were mistakes made in an early PR and then _copied forward_ into every sibling that
followed. A bug found at PR-3 costs one fix; the same bug after PR-8 costs six.

**Runs unattended.** epic-run exists to be kicked off overnight or from work, so this must
never wait on a human. The insight that makes that possible: what a fresh reviewer catches
isn't a function of being human — it's a function of **arriving cold, without build context,
seeing the whole vertical at once.** The builder cannot see the redundant string because it
knows why the string is there. Cold-ness is reproducible; wakefulness is not.

### 1. Capture

Add the epic's new routes to the project's UI-sweep route list (the extension names the file;
surface-adding PRs should add their routes in the same PR), then run the project's UI sweep
(named in `.claude/fwd/epic-run.md`, as `uiSweep` in `.claude/fwd.json`). A sweep should
produce a full-page screenshot per route × viewport, ideally with overflow heuristics, for
every auth state the routes need (signed out, signed in, admin).

Prerequisite: whatever test-account credentials the sweep needs must be placed, and it should
run against **staging**, never production (the extension names the guard and the credentials).
If the creds aren't placed, say so in the run report and fall back to driving local dev with
Playwright screenshots — do not silently skip the capture.

### 2. Cold-eyes critic subagent

Dispatch a subagent whose context is deliberately starved. Give it **only**: the screenshot
reel, the design handoff, the locked customer-facing vocabulary from `copy-review`'s project binding (`.claude/fwd/copy-review.md`), the project's voice rules,
and the Recurring Defect Classes list. **Do not give it the plan, the diffs, the PR bodies,
or any rationale** — that context is exactly what blinds the builder.

Its brief is to be picky about copy, affordance and IA, and to answer: which strings say
something the surrounding UI already says; which control's purpose isn't obvious without
explanation; where does a surface offer no way back; what would a first-time user
misread. Ask for a ranked list with a severity per item, and for it to say plainly when it
has nothing — a critic that always finds five things is noise.

### 3. Triage and continue — do not wait

Fix everything valid in the current run, not as follow-ups. Then, before resuming the build,
re-read the remaining PRs' scope against the triage list: anything the review invalidated
gets amended in the plan _before_ it is built. That re-read is the step that stops a PR-3
mistake reaching PR-8.

### 4. Notify, don't block

Post the review summary and the screenshot path to the user via push notification, then **keep
building**. If they're awake they can interject and that's a bonus; if they're asleep the run
continues. Never schedule a wakeup to wait for a reply here.

### 5. Reserve the final PR slot for polish

Plan the last PR of every epic as an unscoped polish PR. The cold-eyes proxy shrinks the user's
morning findings; it does not eliminate them, and genuinely subjective calls
(tooltip-vs-inline weight, how much explanation a CTA deserves) will still land on them. A
reserved slot means those land in one branch instead of spawning four cleanup PRs after the
run is already closed.

**Honest expectation:** this converts a long morning list into a short one. It is not a replacement
for the user's eye, and reporting it as one is the attestation failure in a new costume.

## The Gates

These gates came out of a forensic pass over several epics that passed a single
design-review gate and still leaked a steady stream of post-merge UI/UX bugs. By class,
largest first: state reachability and interaction/loading/flow (together about half),
then visual fidelity, copy, cross-surface drift and responsive layout.

**The dominant half is one blind spot wearing two hats.** A component-vs-mock comparison
cannot see them, because the component renders correctly _when handed the right props_ —
what's wrong is that the app never hands it those props. Canonical case: one PR, a shimmer
loader that was structurally unreachable because a sibling PR's SSR seed made
`isPending` false on first render. Type fine, route fine, handoff matched, state impossible.

Gates 1–3 exist because of that. Order matters; each is cheap relative to the bug class it
catches. **Each produces a committed artifact — an unenforced gate is what already failed.**

**Gate 5 came later**, after further epics kept leaking bugs _with Gates 1–4 in force_. The
diagnosis: Gates 1–4 are all per-PR and single-pass, while the surviving bugs were cross-PR,
lifecycle, or premise-level. Two canonical cases — a "Join" button that appeared inert
because the page is server-rendered with no optimistic path, and a nudge that never returned
after leave → re-join because its dismissal was keyed by the group's id instead of the
membership's id. Both render correctly on a single forward pass. Neither survives being run
twice.

### When each gate fires

| Gate                        | Scope                          | Fires                                          |
| --------------------------- | ------------------------------ | ---------------------------------------------- |
| 1 State reachability        | API→UI seam                    | Before the UI PR's build starts                |
| 2 Forced-state runtime      | Per PR                         | Before `gh pr create`                          |
| 3 Sibling duplicate sweep   | Per PR                         | Before `gh pr create`                          |
| 4 design-review both halves | Per PR (Agent 1 pre-epic)      | Agent 1 before any code; Agents 2–3 pre-PR     |
| 5 Journey lifecycle         | **Per journey, across PRs**    | As soon as the journey is reachable end-to-end |
| 6 Side-effect provenance    | Per trigger the spec names     | Before `gh pr create` on the PR adding it      |
| 7 Copy review               | Per PR that adds or edits copy | Before `gh pr create`                          |

Gates 1, 5 and 6 are not per-PR: Gate 1 fires per API→UI seam, Gate 5 per journey and Gate 6
per trigger the spec names. Do not collapse Gate 5 into a PR checklist — it fires on journeys,
and a journey usually spans three or four PRs.

### Gate 1 — State reachability (at the API→UI seam)

Runs when an API PR precedes a UI PR, **before the UI PR's build starts**, not inside it.
Borrowed from complete-and-ship's Step 2.5 (API contract verification gate) and widened; Step 2.5 as written passes that shimmer PR.

For every state named in the handoff's state-coverage table, answer all three:

1. **Type** — is the triggering field present in the response type?
2. **Route** — does the route actually compute and assign it, or is it a `= null` stub?
3. **Runtime reachability** — _given how this component is actually mounted, seeded and
   cached, can the triggering condition ever be true?_ Read the caller, the SSR/prefetch
   path, and any parent that supplies initial data. This is the question that catches the shimmer PR.

Mark each ✅ / ⚠️ (type present, route incomplete) / ❌ (not surfaced) / 🚫 (unreachable at
runtime). **Any ⚠️ ❌ 🚫 → fix before the UI build begins**, or escalate. Commit as
`docs/superpowers/state-coverage-<epic>.md`.

### Gate 2 — Forced-state runtime exercise

**Not borrowable from complete-and-ship — it isn't there.** This is the other half of the dominant class:
retry that doesn't retry, reload orphaning an in-flight OAuth, 403 from every entry point,
missing loading states, post-paint pop-in. All invisible to static analysis; all require
driving the app.

Start the dev server and exercise every state the handoff names — **forcing** each one
(throttle/offline for loading, mock a 4xx/5xx for error, empty the fixture for empty, and
reload mid-flow for anything multi-step). Check mobile and desktop viewports. Record what
you forced and what you saw in the PR body. "Renders in the happy path" is not this gate.

If a state cannot be forced locally, say so explicitly and validate it on staging before
merge rather than silently skipping it.

### Gate 3 — Sibling-surface duplicate sweep

A share of the leaked bugs were mechanical: one PR updated an options list in one form while
a sibling form kept a byte-identical copy of the old list; another renamed a destination and
left a nav tab still carrying the old label.

For every array, constant, or user-facing string this PR changed, grep the codebase for the
_old_ value. Any other surface still holding it is in scope for this PR. Same "sweep the
class, never patch the flagged instance" rule as `pr-review`, applied to code. Swept means a grep produced the claim.
Also grep for locked-vocabulary violations (the vocabulary lives in `copy-review`'s project binding, `.claude/fwd/copy-review.md`) — most of the copy bugs were that.

### Gate 4 — Design-review, both halves

The old gate ran only design-review's _second_ half. Run both:

- **Pre-implementation:** Agent 1 (enumerate) against the handoff **only**, before any code
  exists. Commit to `docs/superpowers/design-tables/<epic>.md` and **pass it into every
  build subagent's prompt** — otherwise subagents build blind and the later gap pass is
  open-ended discovery rather than a deterministic checklist.
- **Pre-PR:** Agent 2 (verify) against that table + the implementation, fix all gaps at
  once, then Agent 3 (confirm) on the gap list. If gaps remain, fix them and re-run Agent 3
  **once more**, on those items only (four calls at most). If that re-run still finds gaps,
  list them in the gap report and report them; proceed only at **0 gaps** or once the user
  accepts the listed remainder.

Note the honest limit: the visual-fidelity misses were mostly second-order regressions
from sibling PRs, surfaced by a human clicking through staging with real data. Gate 4 is
worth running, but Gates 1–3 and staging validation are what move the number.

### Gate 5 — Journey lifecycle (forward, reverse, repeat, resume)

Gates 1–4 run a state or a component **once, forward**. Real users run journeys backwards
and twice. For every journey in the briefing's walk script, run all four passes:

1. **Forward** — the happy path, with realistic data.
2. **Reverse** — undo every commit the journey makes. Unfollow. Leave. Dismiss. Delete.
   Cancel mid-flow. Does the UI return to a genuinely pre-action state, or a hollow one?
3. **Repeat** — do → undo → **redo**. This is the pass that finds keyed-state bugs. Ask of
   every dismissal, "seen" marker, one-time banner, tour, or localStorage flag: **what key is
   this stored under, and does that key die when the underlying thing dies?** The nudge above
   was keyed by the group's id (immortal) instead of the membership's id (deleted on leave),
   so one dismissal silenced it forever.
4. **Resume** — reload mid-journey, and open the journey in a second session/device. Anything
   held only in component state or a single tab's memory shows up here.

**Mutation feedback sub-check.** For every mutation reachable in the journey, time the gap
between the click and the visible state change. On a server-rendered page a mutation with no
optimistic path looks broken — that is the inert "Join" button exactly. Throttle the network to
make the gap obvious; a fast local machine hides this bug completely. If you add an
optimistic override, clear it on the **server value changing**, not on mutation success —
clearing on success drops the override before the new HTML lands and flashes the old state.

Record the four passes per journey in `docs/superpowers/journey-lifecycle-<epic>.md`.
Any journey that cannot be fully exercised locally is named explicitly and walked on staging
before the epic is called done.

### Gate 6 — Side-effect provenance (non-UI features)

Gates 1–5 all assume the bug is visible. For a feature whose core is a _record that gets
created by something else happening_ — notifications, digests, sync jobs, audit rows — the
characteristic failure is silent: the thing never fires, fires twice, or fires for the wrong
user. No amount of clicking through a rendered list finds it.

For every trigger the spec names, prove three things by running it, not by reading it:

1. **Fires** — perform the real upstream action; confirm the record exists.
2. **Fires once** — perform it twice, and concurrently if the trigger can race. Idempotency
   key named explicitly, or a stated reason one isn't needed.
3. **Fires for exactly the right audience** — a second user's account confirms non-delivery.
   Fan-out bugs are invisible from a single account.

Then the lifecycle: what marks it read/handled, what happens on a second device, what
happens to old records (retention/pruning), and what the empty state is before any trigger
has ever fired — that last one is the state a brand-new user actually sees first.

Commit as `docs/superpowers/side-effects-<epic>.md`. Fires when the feature creates records
in response to events; skip it, with a line saying why, when it does not.

### Gate 7 — Copy review (any PR that adds or edits customer-facing strings)

Copy was a recurring class in the forensic pass above, and a later full-codebase copy audit
found far more, which is what a feature epic looks like when nobody reads the strings before
they merge. Copy is the one artifact in a PR that ships straight to a customer's eyes with
no compiler and no test asserting it reads well.

Fires when `git diff main...HEAD --name-only` touches any file in the copy inventory named
by `copy-review`'s project binding (`.claude/fwd/copy-review.md` in the project) or a
design handoff containing copy — or when the PR adds any new user-visible string inline in
a component file. Run the **`copy-review`** skill over the diff, apply what it flags, and re-run the
quality gate before `gh pr create`. The binding file also names the project's frozen areas;
flag drift there to the user rather than editing.

**Check whether the project has a mechanical backstop before relying on one.** Where a lint
rule forbids inline literals (such as `react/jsx-no-literals`), a clean lint covers JSX text
only. The lint config itself is the one place to check: grep it directly (the extension may
note the answer, but the config wins). Either way, read the diff for strings the rule cannot
see: function arguments such as `toast.error(...)`, strings in variables, and on-screen error
messages. Where it has no such rule, the diff must be read for every inline string by hand. Lint catches placement either way; this gate catches voice, length and vocabulary.

Skip the gate, with a line saying why, on a PR that touches no copy at all.

## Evidence, not attestation

Every gate artifact records **what was run and what came back** — the command, the forced
condition, the observed output. A gate artifact that says "verified ✅" with no evidence is
an attestation, and attestations are what the old single gate was.

**"Blocked" and "not applicable" are claims about the repo and must be checked against it.**
On one epic a gate was reported un-runnable because "admin sits behind the auth provider
with no headless login" — the project's audit helpers had exported a headless admin sign-in
the whole time, and the existing sweep already covered admin routes with it. The user
caught it. Reporting a gate
as blocked when the tooling exists is worse than failing it: it retires the gate silently.
Grep for the capability before claiming its absence.

**Every bug the walk finds ships with a regression test.** Where the bug is route- or
auth-shaped, add the route to the project's UI-sweep route list rather than writing a bespoke
test — that converts a
one-time finding into standing coverage. Assert the _mapping_, not the existence: an
href-set assertion is not a routing test.

## Which gates fire when

Running all seven on every PR is how the whole thing gets skipped at 2am. Scope them:

| PR shape                                         | Gates                                                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| Migration / schema only                          | none (plus normal review bar)                                          |
| API / route only                                 | 6 if it creates records; 1 runs _after_ it, before the dependent UI PR |
| UI PR                                            | 2, 3, 4, plus the Defect Classes list                                  |
| Any PR adding or editing customer-facing strings | 7, whatever else applies                                               |
| First PR making a journey reachable end-to-end   | 5, and trigger the mid-run cold-eyes review                            |
| Any PR touching a launch flag or route matcher   | Defect Classes row 6 (auth matrix), always                             |

The Defect Classes list is the cheapest thing here and the highest-yield per minute — read it
on every UI PR even when the expensive gates are scoped out.

**Name the epic's risk shape in the briefing and over-invest there.** Three shapes recur:

- **Event-driven** (notifications, digests, syncs) — the record is created by something else
  happening. Risk is silent non-delivery, duplicates, wrong audience, and unbounded growth.
  Gate 6 is the whole ballgame; Gate 5's repeat pass is second.
- **Content/data-driven** (an entity page fed by crawled or third-party data) — risk is the
  long tail: missing images, absent fields, one-item and thousand-item collections,
  pathological strings. Gate 2 with _deliberately ugly_ fixtures, not clean ones. Real prod
  data is the only honest test; several visual misses only ever surface that way.
- **Copy/IA-driven** (guides, onboarding, explainers) — no runtime to break, so gates say
  nothing. Risk is redundancy, wrong vocabulary, and a surface with no way back. Gate 7 is
  mandatory on every PR of this shape — the strings _are_ the feature. Defect Classes rows
  6, 8 and 11 plus the cold-eyes review are where the value is; don't burn a night on
  Gate 2 for a static page.

## Recurring Defect Classes — check every UI PR against this list

Gates catch classes; this list catches _instances_. Every row below is a real bug that
shipped past a passing gate and cost a cleanup PR. Walking a journey finds
these only if the walker is lucky — reading the list finds them deterministically. Cheap:
most are a single grep or a single question per PR.

| #   | Rule                                                                                                                                                                                                                                                                                                                    | Escaped as                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1   | A disabled or blocked control must render **what it is waiting on**, wired with `aria-describedby`. Silent-disabled reads as broken.                                                                                                                                                                                    | A form's Continue button disabled with no reason shown      |
| 2   | No interactive element nested inside another. A `<button>` inside a `<Link>` sends every click to the link, and `pointer-events: none` makes it worse, not better — it makes the trap invisible.                                                                                                                        | A card's inner action that only ever followed the card link |
| 3   | Any `position: fixed` overlay **portals to `document.body`**. A transformed or clipping ancestor makes `fixed` resolve against that box, not the viewport — and filter rails, carousels and sheets are all transformed. Fix in the shell component, never at the one call site that surfaced it.                        | A modal trapped inside a transformed filter rail            |
| 4   | A shared component reachable from N entry points must **key its copy off the entry**, not off a default. Add the entry prop before the second call site exists.                                                                                                                                                         | A sign-up sheet showing the wrong action's pitch            |
| 5   | Gate at the **earliest** point the user could learn, not at submit. Filling a form and being rejected by the POST is the failure mode. Gate inside the modal/flow, which covers all call sites at once — not at each trigger.                                                                                           | A signed-out user rejected only on submit                   |
| 6   | **Auth-matrix sweep:** every route this epic newly links to, crossed with every auth state and every launch-flag state, checked against the middleware matchers. A route linked from a surface but absent from both public matchers is a dead end.                                                                      | A newly linked public page that redirected to sign-in       |
| 7   | A state reached **by transition** is not the same as that state rendered fresh. React writes only changed props, so a shorthand (`background`) can silently strip a longhand (`background-clip`) set elsewhere. Prefer longhands in anything that animates or toggles; verify by flipping state, not by mounting in it. | Carousel dots losing their style after a toggle             |
| 8   | For each new user-facing string: **does it say something the adjacent UI does not already say?** If the dashed container already reads as an example, the "example" caption is noise. Redundant reassurance reads as insecurity.                                                                                        | Captions restating what the layout already said             |
| 9   | The same gesture must be the same affordance at **every breakpoint**. A label that appears only on desktop reframes the icon as a mobile shorthand, and contradicts teaching copy that calls the icon the whole gesture.                                                                                                | An icon labelled on desktop only                            |
| 10  | DOM order is **mobile** order. A sidebar/rail placed after a long list is unreachable on a phone. Put it first in the DOM and pin desktop placement explicitly (`lg:col-start-*` / `lg:row-start-*`) so the desktop layout is unchanged.                                                                                | A side rail stranded below a long list on phones            |
| 11  | Do not name a tier or entitlement on a surface **only entitled users can reach**. The locked takeover is where a user meets the price; a chip on the unlocked surface is a tax on people who already paid.                                                                                                              | A paid-tier chip on a paid-only page                        |
| 12  | A mutation on a server-rendered page needs an optimistic path, cleared on the **server value changing** — not on mutation success, which drops the override before the new HTML lands and flashes the old state back.                                                                                                   | A Join button that looked inert                             |
| 13  | Dismissals, "seen" flags and one-time banners are keyed by an id that **dies when the thing dies**. A key that outlives its subject makes the dismissal permanent. Use a new storage key when the stored shape changes — a strict type guard rejects the whole store on one stale value.                                | A nudge silenced for good by one dismissal                  |

When a PR trips a row, sweep the class across the codebase rather than patching the flagged
instance — same rule as Gate 3 and `pr-review`. Add a row whenever a walk finds a bug
that no existing row would have caught; that is how this list stays worth reading.

## Escalation Classes

- **Hard pause** — stop and ask; do not proceed: (a) any PRODUCTION database migration, (b) anything the briefing lists as a hard pause, (c) ambiguity the specs/briefing don't resolve — ask, don't invent.
- **Notify-and-proceed** — for actions the briefing lists here: first validate the identical flow in the safe mode (test mode, staging), capture concrete evidence, post the evidence summary, then execute and continue. The evidence trail is the control, not synchronous approval.
- **Secrets:** never ask the user to paste secrets in chat. List new env vars in the PR body (name, purpose, creation instructions) and pause the dependent step until placed.
- Everything else reversible and in-scope: decide and proceed.

## Red Flags — STOP, you are about to repeat a documented failure

| Thought                                                      | Reality                                                                                                                            |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| "I'll just edit this one file in the main repo dir"          | Every file change happens in a worktree. Every one.                                                                                |
| "Subagent can handle the review round-trip"                  | The multi-minute review wait exceeds its window. Orchestrator owns reviews.                                                        |
| "All the PRs merged green, the feature is done"              | Green PRs left three gaps at the seams. Walk the inventory.                                                                        |
| "Copilot request returned 200, we're good"                   | Verify on the issue timeline — REST omits bots, so the empty array proves nothing either way.                                      |
| "The review came back, let me triage it"                     | Compare its `commit_id` to the PR `head.sha` first. Stale rounds are the largest avoidable cost in the loop.                       |
| "Same finding a third time, one more fix"                    | Third round on one surface = scope decision, not another fix.                                                                      |
| "One review errored but the other passed"                    | Errored reviews don't count. Two SUCCESSFUL reviews.                                                                               |
| "These nits can be follow-ups"                               | Fix every valid comment; only once the bar is met does a leftover nit ride in the merge or become a follow-up (pr-review).         |
| "It's animation-only, skip design-review"                    | design-review gates every UI PR, no exceptions.                                                                                    |
| "The component matches the mock, ship it"                    | Half the leaked bugs matched the mock. Ask whether the app ever hands it those props.                                              |
| "The field is in the type and the route sets it"             | That's Gate 1 questions 1–2. The shimmer PR passed both and was still unreachable. Read the caller.                                |
| "I rendered the happy path, states look fine"                | Gate 2 means _forcing_ loading/error/empty/reload-mid-flow, not observing the happy path.                                          |
| "I changed the constant in the component I was given"        | Grep the old value. A sibling surface holding a byte-identical copy is this PR's problem.                                          |
| "design-review passed"                                       | Both halves? Agent 1 pre-implementation, table committed and fed to subagents? Or just the verify pass?                            |
| "Merged — deploys are automatic"                             | Verify the workflows ran; some merge paths skip them.                                                                              |
| "I'll update the checkpoint note at the end of the run"      | Update after EVERY merged PR; sessions die without warning.                                                                        |
| "The briefing says the env var is placed"                    | Verified then ≠ true now. Re-verify at kickoff.                                                                                    |
| "I'll review the whole vertical at the end"                  | One epic did: a long bug list, several cleanup PRs, many copied forward from PR-3. Cold-eyes review at the halfway point.          |
| "I'll pause here for the user to walk it"                    | The run is unattended by design — they kick it off from work or asleep. Notify and keep building; never wait.                      |
| "I'll give the critic subagent the plan for context"         | That context is what blinds the builder. Starve it: screenshots, handoff, vocabulary, voice rules. Nothing else.                   |
| "The cold-eyes pass found nothing, so the vertical is clean" | It shrinks the morning list, it doesn't empty it. Reserve the polish PR slot regardless.                                           |
| "The journey works"                                          | Forward only? Gate 5 is forward + reverse + repeat + resume. The repeat pass is where the bugs are.                                |
| "Dismissed state persists correctly"                         | Keyed by what? If the key outlives the thing it describes, the dismissal is permanent.                                             |
| "The mutation succeeds, I saw the row change"                | Did the _UI_ change before the round-trip? On an SSR page, no optimistic path reads as broken.                                     |
| "The plan doesn't mention a launch gate, so there isn't one" | Absence isn't a decision. Ask before PR-1, not after the vertical is live.                                                         |
| "That state has no home, but it's out of scope"              | It's the plan's scope gap, not the user's. Escalate — it's a product call.                                                         |
| "The notification renders correctly in the list"             | Does it _fire_? Once? For the right user only? Gate 6 runs the trigger, twice, from two accounts.                                  |
| "I can't run that gate here"                                 | That's a claim about the repo. Grep for the capability first — one epic declared a gate blocked while the tooling already existed. |
| "The copy is fine, I wrote it carefully"                     | So did the author of every string a copy audit ever flagged. Gate 7 is a second pair of eyes, not a spellcheck.                    |
| "Gate passed ✅"                                             | With what evidence? The artifact records the command run and the output seen, or it's an attestation.                              |
| "Copy matches the handoff"                                   | Does it say something the surrounding UI doesn't already say? Redundant reassurance is the commonest copy bug.                     |

## Done Means

All execution-plan phases complete through staging validation; every PR merged at the full bar; **every gate that fires for this epic passed with its committed artifact, scoped as "Which gates fire when" says — 1 at every API→UI seam, 2–4 on every UI PR, 5 on every journey, 6 on every trigger, 7 on every PR that adds or edits customer-facing copy — and each artifact records evidence, not attestation**; the Recurring Defect Classes list read on every UI PR; the mid-run cold-eyes review ran as soon as the first journey was reachable end-to-end, and its triage list is closed (blockers fixed in-run, polish landed in the reserved final slot); briefing's "Done means" items satisfied; launch gate in the state the briefing specifies; launch-day/runbook steps documented if the briefing calls for them.

**Close-out runs `feature-acceptance` before the report.** Every row of the plan's
route × viewport inventory walked in a real browser against the brief, the contact
sheet produced, import-equality and marker checks passing. A feature line whose PRs
all merged green is still unfinished until that walk happens — on the motivating
case, five green PRs left three gaps at the seams between them, none of which any
review round could have seen.

**Final report format is not free-form.** Invoke the `feature-run-report` skill: it emails the run report (per-project progress bars, what is ready to test and how, what waits on the user) and pings the phone. Divergence from its shape loses signal.
