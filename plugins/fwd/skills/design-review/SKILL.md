---
name: design-review
description: Use to compare a UI implementation against a design handoff. Separates enumeration from verification so every property is caught in a single cycle rather than through repeated open-ended discovery passes.
---

# design-review

**First, read the project's own rules.** If `.claude/fwd/design-review.md` exists in the project, read
it before anything else: it names the project's own tools and conventions for this skill, and
its rules add to these and win where they conflict.

**Scope note.** This skill compares an implementation to a handoff, file by file.
It cannot tell you that a route never mounted the component, that a phone layout
diverged from its desktop, or that a surface reimplemented what another route
already had — those live between files and between PRs. Run `feature-acceptance`
alongside it, and run this skill **against the whole brief at feature close**, not
only per PR: run per PR it reads a slice and confirms the slice, which is how five
green PRs shipped three gaps at their seams.

## Before any UI PR opens: the `## Design review` table

**Every UI PR runs this skill's verify pass before `gh pr create`, and records it in the PR body
under `## Design review`.** A UI PR is any PR that changes what a user sees: components, styles,
layout, a route's rendering. The orchestrator does not merge a UI PR without the section, however
green its review and CI.

Before that, two things must already hold:

- **The handoff has a READINESS verdict** (the `readiness-review` skill). No UI work starts on a
  handoff without one, whatever its age.
- **`design/` is reference, never source.** Never import from the handoff folder, and never copy
  its assets into `public/` or any shipped folder. Rebuild what it draws in the app's own
  components and tokens; an asset the app ships goes through the project's own asset pipeline.

The section is a table with one row per property this PR builds: the rows come from the property
table that Agent 1 wrote, and Agent 2 (plus Agent 3, where it ran) verified each. Every row is
checked; none is sampled.

```markdown
## Design review

Handoff: `design/<handoff>/` (READINESS 🟡 Yellow) · property table: `<path>`

| Element     | Property   | Phone: design → built            | Desktop: design → built | Result                                |
| ----------- | ---------- | -------------------------------- | ----------------------- | ------------------------------------- |
| Toolbar     | height     | 48px → 48px                      | 56px → 56px             | ✅                                    |
| Toolbar     | background | var(--surface) → var(--surface)  | same                    | ✅                                    |
| Empty state | layout     | not drawn → the list empty state | same                    | 🔸 nearest pattern: `/projects` empty |

Verdict: 3 rows, 2 match, 1 resolved from the nearest drawn pattern, 0 gaps. Contact sheet: <link>.
```

Results: ✅ match · ❌ mismatch (fix it before opening) · 🔸 resolved from the nearest drawn
pattern (name the pattern) · ⛔ gap (that piece stopped, ruling pending). A PR opens with no ❌
rows, and with ⛔ rows only for pieces it does not build.

### Ambiguity is resolved; only a real gap goes back to Design

Handoffs are expected to be comprehensive. **A small ambiguity is not a gap.** When the boards
leave a detail open (an unlabelled spacing, a state drawn on one surface and implied on another, a
hover the handoff's other controls already show), resolve it from the nearest drawn pattern: the
same handoff first, then the shipped component it most resembles. Record it as a 🔸 row naming the
pattern, and keep going.

**A gap is something the boards truly do not cover:** a screen, a state or a behaviour with no
drawn pattern to follow, or two drawn patterns that contradict each other. Then **that piece
stops**. Report it to the orchestrator (or the user, when there is none) with what is missing and a
recommendation; it goes back to Design only on the user's ruling. The rest of the PR's pieces
continue. Never invent a design for a real gap, and never send Design a mismatch the drawn patterns
already settle. Wording is never a Design gap: it goes to `/copy-review` (below).

## Overview

Converts open-ended design gap hunting into a deterministic lookup. The skill runs in three agent calls in the normal case, and four at most (one bounded Agent 3 re-run) — never ten. It separates two cognitively distinct tasks (enumerate vs. verify) that, when combined, cause attention drift and missed properties.

**Use this skill:**

- Before implementation, to produce a requirements checklist the implementation subagent must satisfy
- After implementation (pre-PR gate), to verify the checklist is fully satisfied

**Announce at start:** "I'm using the design-review skill to enumerate and verify the design."

---

## When to invoke

This skill is invoked by `complete-and-ship` at two points:

1. **Pre-implementation** — complete-and-ship's "Pre-implementation design enumeration" step, after design assets are copied into the worktree and before "Complete remaining tasks". Output: a property table committed to `docs/superpowers/design-tables/<feature>.md`. Implementation subagents must satisfy this table.

2. **Pre-PR gate** — the UI-verification part of complete-and-ship's "Compare implementation to design spec and design assets" step, replacing open-ended spec comparison. Output: a gap report committed to `docs/superpowers/gap-report-<feature>.md`. All non-deferred gaps must be fixed before `gh pr create` runs.

---

## Copy is not reviewed here — `/copy-review` owns it

**Every finding whose subject is the wording of a user-facing string belongs to the `/copy-review`
skill, not to this one and never to a Design round-trip.** That includes: the choice between two
phrasings, a vocabulary sweep across sibling strings, the noun in a header or empty state, the
wording of an `aria-label`, singular/plural branches, and any new copy key's text.

What stays in scope here is copy's _structure_, not its _content_: a string that is missing
entirely, a key whose interpolation slots do not match its call site, a state the design names for
which no key exists, or a canvas label that contradicts the shipped copy file. Those are gaps —
report them, then hand the wording itself to `/copy-review`.

**Why:** a Design round-trip is expensive and copy does not need one. Routing a vocabulary sweep or
a header noun to Design for ratification costs a full round that `/copy-review` would have settled
in minutes.

**How to apply:**

- Agent 1 enumerates copy keys as _structure_ — which key each element renders and what arguments
  it takes. It does not enumerate the string's text as a property to match.
- Agent 2 verifies the right key is called with the right arguments. A wording difference between
  canvas and code is not a MISMATCH; it is a `/copy-review` item.
- When sorting findings for a verdict, no copy-content item may contribute to Orange or Yellow.
  If the copy items were the only Design-owned findings, the verdict is Green and the copy goes
  to `/copy-review`.
- The same rule governs prompts written _to_ Design: strip copy-content items before sending.

---

## The Three Agents

### Agent 1 — Enumerate (design-only)

**Read only the design files. Do not read implementation files.**

The agent reads every design handoff file (JSX, Figma export, README, images) and produces a **complete property table** — one row per element per property per breakpoint.

**Output format:**

```markdown
# Design Property Table — <Feature Name>

## Component: <ComponentName>

### <ElementDescription> (e.g. "Heading h1")

| Property       | Mobile    | Desktop   |
| -------------- | --------- | --------- |
| font-size      | 28px      | 40px      |
| font-weight    | 800       | 800       |
| letter-spacing | -0.03em   | -0.035em  |
| color          | var(--fg) | var(--fg) |
| margin-bottom  | 18px      | 18px      |

### <NextElement>

...
```

**Property categories to enumerate without exception:**

- **Typography:** `font-size`, `font-weight`, `letter-spacing`, `line-height`, `text-transform`, `font-family` (note: record the CSS variable, e.g. `var(--font-mono)`)
- **Color:** every `color`, `background`, `border-color`, `fill`, `stroke` — record exact CSS variable names (`var(--fg-muted)` not just "muted")
- **Spacing:** `padding` (all sides separately), `margin` (all sides), `gap`
- **Layout:** `display`, `flex-direction`, `align-items`, `justify-content`, `grid-template-columns`, `flex-wrap`
- **Dimensions:** `width`, `height`, `max-width`, `min-width`, explicit pixel sizes on containers
- **Border:** `border-radius`, `border-width`, `border-style`, `border-color`
- **SVG icons:** `width`, `height`, `viewBox`, `stroke-width`, `stroke-linecap`, `stroke-linejoin`, path `d` attribute, `r` on circles, `fill`
- **Hover/interactive states:** every style change on hover or focus
- **Transitions:** `transition`, `transform` on hover
- **Conditional rendering:** what renders when featured=true/false, filters active/inactive, empty state, alwaysOn, etc.
- **Responsive variants:** if mobile and desktop differ, both must appear in the table
- **Named states (state coverage):** if the design README has a state coverage table (columns like "State", "Trigger", "Visual"), enumerate every row as a state entry — see format below

**State coverage section (add when design has a state table):**

```markdown
## State Coverage — <ComponentName>

| State          | Triggering condition                    | Component rendered | Key props required        |
| -------------- | --------------------------------------- | ------------------ | ------------------------- |
| Active         | status='active', lastSeenAt != null     | UserCard           | name, avatarUrl, lastSeen |
| Pending invite | invite != null AND status='pending'     | PendingInviteCard  | invitedBy, expiresAt      |
| Suspended      | status='suspended' AND suspension!=null | (inline banner)    | suspension.reason         |
| Empty          | users=[]                                | (empty-state card) | —                         |
```

List every state from the design's coverage table. Include the exact API field+value that triggers it. This table becomes the input for Agent 2's state reachability pass.

**Rules for Agent 1:**

- If a value is the same on mobile and desktop, write it once in both columns
- If a value is absent (not set), write `—` not a guess
- Record exact numeric values from the design source (e.g. `gap: 7`, not "about 7px")
- Do not infer — if a property is not specified in the design, omit it from the table
- Group by component, then by element within component
- Every interactive state (hover, focus, active) gets its own subsection

**Agent 1 prompt template:**

```
You are producing a design property table from design handoff files. Read ONLY the design files — do not read any implementation files.

Design files to read:
<list all design handoff files>

Your output is a complete property table — every component, every element, every CSS property, every value, with mobile and desktop columns. This table will be used as a deterministic checklist for implementation verification.

Property categories to enumerate without exception:
- Typography: font-size, font-weight, letter-spacing, line-height, text-transform, font-family (CSS var)
- Color: color, background, border-color, fill, stroke (exact CSS variable names)
- Spacing: padding (all sides), margin (all sides), gap
- Layout: display, flex-direction, align-items, justify-content, grid-template-columns, flex-wrap
- Dimensions: width, height, max-width, min-width, fixed pixel sizes
- Border: border-radius, border-width, border-style, border-color
- SVG icons: width, height, viewBox, stroke-width, path d attribute, circle r, fill
- Hover/interactive states: every style that changes on hover or focus
- Transitions/transforms
- Conditional rendering: what shows/hides under which conditions
- Responsive variants: mobile vs desktop (at the project's mobile breakpoint: <name it from .claude/fwd/design-review.md>)

Format output as:

# Design Property Table — <Feature>

## Component: <Name>
### <Element>
| Property | Mobile | Desktop |
|----------|--------|---------|
| ... | ... | ... |

Rules:
- Record exact values from source (gap: 7, not "about 7px")
- If a property is not set in the design, omit it
- Write — when a value is explicitly absent
- Every hover state gets its own subsection under the element
```

---

### Agent 2 — Verify (table + implementation)

**Read the property table AND implementation files. Go row by row.**

The agent receives the property table and checks each row against the implementation. This is binary lookup, not discovery.

**Tailwind spacing reference (include in every verify prompt when the project uses Tailwind; otherwise substitute the project's own spacing scale):**

```
Tailwind base = 4px (1 unit = 4px):
gap/padding/margin:
  0.5 = 2px   1 = 4px   1.5 = 6px   2 = 8px   2.5 = 10px   3 = 12px
  3.5 = 14px  4 = 16px  5 = 20px    6 = 24px  7 = 28px     8 = 32px   10 = 40px
text sizes: sm=14px base=16px lg=18px xl=20px 2xl=24px 3xl=30px 4xl=36px
```

**Output format:**

For each table row, output one of:

- `✅ MATCH` — implementation matches design
- `❌ MISMATCH — design: X / implementation: Y` — with exact values

Collect all mismatches into a numbered gap list at the end.

**Agent 2 prompt template:**

```
You are verifying an implementation against a design property table. This has TWO passes: visual properties first, then state reachability. Both are deterministic lookup — not open-ended discovery.

Property table (source of truth):
<paste the property table>

State coverage table (if present):
<paste the state coverage section from the property table>

Implementation files to read:
<list all implementation files — include API route files if state coverage table exists>

TypeScript response types to check (if state coverage table exists):
<list relevant *types*.ts or index.ts type files>

Tailwind spacing reference (4px base):
gap/p/m: 0.5=2px, 1=4px, 1.5=6px, 2=8px, 2.5=10px, 3=12px, 3.5=14px, 4=16px,
         5=20px, 6=24px, 7=28px, 8=32px, 10=40px
text: sm=14px, base=16px, lg=18px, xl=20px, 2xl=24px, 3xl=30px, 4xl=36px

─────────────────────────────────
PASS 1 — Visual properties
─────────────────────────────────

For EACH row in the property table:
1. Find the corresponding element in the implementation
2. Check the property value — also check what props are being passed to child components in the same branch (not just CSS values)
3. Output: ✅ MATCH or ❌ MISMATCH — design: X / implementation: Y

─────────────────────────────────
PASS 2 — State reachability (only if state coverage table was provided)
─────────────────────────────────

For EACH state in the state coverage table:
1. Triggering condition — is the required API field present in the relevant TypeScript response type?
2. Route check — does the API route actually compute and assign that field, or is it stubbed as null/undefined?
3. Component branch — does the implementation have a conditional branch that handles this triggering condition?
4. Props check — in that branch, are the required props passed correctly to the rendered component?

Output for each state:
✅ REACHABLE — field in type, route computes it, component branch exists, props correct
⚠️ PARTIALLY REACHABLE — [what's missing: type stub / route doesn't assign / wrong props]
❌ NOT REACHABLE — [reason]

─────────────────────────────────
Gap list
─────────────────────────────────

## Visual gaps
1. File:path — Element — Property — design: X → implementation: Y

## State reachability gaps
1. State name — issue description — file:line

VERDICT: N visual gaps, M state gaps
```

---

### Agent 3 — Confirm (one final pass)

After all gaps from Agent 2 are fixed, run one confirmation agent. This agent receives:

- The gap list from Agent 2
- The implementation files

It checks only the previously-flagged items. It does NOT do open-ended discovery again.

**Agent 3 prompt template:**

```
Confirm that previously identified gaps are now fixed. Check ONLY these items:

<paste the gap list from Agent 2>

Implementation files:
<list implementation files>

For each item: FIXED or STILL WRONG — design: X / implementation: Y

VERDICT: N gaps remain (0 = ready to ship)
```

---

## Integration with complete-and-ship

### Pre-implementation

In complete-and-ship's "Pre-implementation design enumeration" step — after "Worktree and design asset bootstrap", before "Complete remaining tasks":

1. Run Agent 1 on design handoff files
2. Save the property table to `docs/superpowers/design-tables/<feature>.md`
3. Commit it: `git commit -m "docs: design property table for <feature>"`
4. Reference this table in the plan — implementation tasks must satisfy it
5. Pass the table to implementation subagents so they know exactly what to build

### Pre-PR gate (in complete-and-ship's "Compare implementation to design spec and design assets")

After "Quality gate", before "Scan for new environment variables" and the PR opening:

1. Run Agent 2 using the committed property table + implementation files
2. If gaps found: fix all of them, re-run quality gate, then run Agent 3
3. If Agent 3 returns 0 gaps: write gap report and commit it
4. If Agent 3 still finds gaps: fix them and re-run Agent 3 **at most once more**, on those items only (not Agent 2 again)
5. If that re-run still finds gaps, stop iterating: list the remaining gaps in the gap report and report them to the user rather than opening the PR as if clean. Proceed to the PR only after Agent 3 returns 0 gaps or the user accepts the listed remainder

**The pre-PR gap report** still follows the format of complete-and-ship's "Produce and commit a gap report" sub-step, committed to `docs/superpowers/gap-report-<feature>.md`.

---

## What this prevents

| Problem (old approach)                               | Solution                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| Open-ended discovery misses properties each pass     | Agent 1 enumerates everything upfront; Agent 2 checks exhaustively |
| 10+ review rounds to converge                        | 3 agent calls: enumerate → verify → confirm (one bounded re-run)   |
| "New" gaps in round N that existed in round 1        | Property table is complete; Agent 2 checks every row               |
| Attention drift when enumerate + verify are combined | Separated into distinct tasks with focused prompts                 |
| Agent notices different things each pass             | Agent 2 follows a fixed checklist, not open attention              |

---

## Property table example (excerpt)

```markdown
# Design Property Table — Projects Index

## Component: ProjectFeatureCard

### Desktop — Media panel

| Property   | Mobile               | Desktop              |
| ---------- | -------------------- | -------------------- |
| height     | —                    | 240px                |
| background | var(--surface-media) | var(--surface-media) |

### Desktop — Avatar

| Property           | Mobile                 | Desktop                |
| ------------------ | ---------------------- | ---------------------- |
| position           | absolute               | absolute               |
| left               | 14px                   | 14px                   |
| bottom             | 14px                   | 14px                   |
| padding            | 8px 12px               | 8px 12px               |
| border-radius      | 8px                    | 8px                    |
| background (dark)  | rgba(0,0,0,0.55)       | rgba(0,0,0,0.55)       |
| background (light) | rgba(255,255,255,0.78) | rgba(255,255,255,0.78) |
| backdrop-filter    | blur(6px)              | blur(6px)              |
| font-family        | var(--font-sans)       | var(--font-sans)       |
| font-weight        | 900                    | 900                    |
| font-size          | 18px                   | 24px                   |
| letter-spacing     | 0.02em                 | 0.02em                 |
| color (dark)       | #FFFFFF                | #FFFFFF                |
| color (light)      | #111111                | #111111                |
| line-height        | 1                      | 1                      |

### Desktop — Meta column (right panel)

| Property        | Mobile | Desktop       |
| --------------- | ------ | ------------- |
| padding         | —      | 24px 28px     |
| display         | —      | flex          |
| flex-direction  | —      | column        |
| justify-content | —      | space-between |

### Desktop — Chevron circle (resting)

| Property      | Mobile | Desktop                        |
| ------------- | ------ | ------------------------------ |
| width         | —      | 36px                           |
| height        | —      | 36px                           |
| border-radius | —      | 50%                            |
| background    | —      | var(--surface-2)               |
| border        | —      | 1px solid var(--border-strong) |
| color         | —      | var(--fg-muted)                |

### Desktop — Chevron circle (hover)

| Property     | Mobile | Desktop             |
| ------------ | ------ | ------------------- |
| background   | —      | var(--accent)       |
| border-color | —      | var(--accent)       |
| color        | —      | var(--fg-on-accent) |
```

---

## Failure modes to avoid

**Agent 1 failure:** Enumerating only the "interesting" properties and skipping values that seem obvious (e.g. `font-family`, `line-height`, `white-space`). The fix: the prompt explicitly lists every category and says "without exception."

**Agent 2 failure:** Re-doing open-ended discovery instead of following the table. The fix: the prompt says "go through every row in the table" and "this is deterministic lookup — not open-ended discovery."

**Agent 3 failure:** Doing a full re-sweep and finding "new" gaps not in the original gap list. The fix: Agent 3 only checks previously-flagged items. New open-ended discovery at this stage means Agent 1 was incomplete — that's a separate issue to address next time.

**Responsive failure:** Only enumerating desktop values and missing mobile differences. The fix: every row has a Mobile column, and Agent 1 is instructed to check both the desktop and mobile design files.

**State coverage failure:** Agent 2 checks CSS properties and reports 0 gaps, but the feature has states that are unreachable because the API never returns the triggering field. CSS verification cannot catch this. The fix: Agent 1 enumerates the state coverage table; Agent 2's Pass 2 explicitly checks that each state's triggering condition is present in the TypeScript response type AND actually computed by the route.

**Props passing failure:** Agent 2 checks that a component has the correct CSS values, but the component is being called with wrong prop values (e.g. `variant={null}` when it should be `variant="compact"`). The fix: Agent 2 Pass 1 explicitly checks what values are passed to child components in each conditional branch, not only the rendered CSS output.
