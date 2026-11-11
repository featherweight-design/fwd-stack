---
name: readiness-review
description: Use when a design handoff lands, before any plan PR or UI work on it — audits the handoff against seven dimensions and writes its READINESS verdict (Green, Yellow, Orange, Red). Required on every handoff, with no exceptions for older ones. Also use when a handoff gains an addendum, to audit the addition.
---

# readiness-review

**First, read the project's own rules.** If `.claude/fwd/readiness-review.md` exists in the
project, read it before anything else: it names where handoffs live, the project's own conventions
to check against, and its rules add to these and win where they conflict.

The gate between a design handoff and the plan that builds it. A handoff can be beautiful and
still unbuildable: a state the API never returns, a token the codebase does not have, a screen
designed before the schema changed. Finding that in the plan costs a paragraph; finding it in the
fourth PR costs a Design round and a rebuild.

## The rule

- **No UI work starts on a handoff without a READINESS verdict.** No plan PR, no component, no
  route. Backend, API and database work may proceed without one.
- **Every handoff, whatever its age.** There is no date before which a handoff is exempt: an old
  handoff is the one most likely to have drifted from the code. An addendum to a handoff gets its
  own audit of the addition.
- **The audit is a cold read.** Run it in a fresh general-purpose subagent (read-only, never a
  fork), given the handoff folder and the paths of the code it touches. A session that helped
  write the handoff reads it as intended.
- A handoff the user relays from Design is already reviewed for taste. The audit is not a design
  critique: it asks whether this can be built as drawn, on this codebase, today.

## The seven dimensions

| Dimension                 | What to check                                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🗺️ **Scope clarity**      | Is the boundary defined? Are non-goals stated? Are open questions logged?                                                                             |
| 🎭 **State coverage**     | Loading, error, empty and signed-out states. Edge cases. Phone and desktop drawn for every surface (parity is not optional).                          |
| 🔌 **Data contract**      | Does the backend support it? Schema or endpoint gaps? Every named state reachable from a real API field and value, not only drawn.                    |
| 🧱 **Codebase fit**       | Uses the project's tokens (no colour, size or font the theme lacks)? Reuses existing components? Follows the project's copy and constant conventions? |
| ♿ **Cross-cutting**      | Accessibility addressed? Performance implications? Analytics or telemetry expectations?                                                               |
| ⏰ **Drift from reality** | Designed before a major change (schema, platform, navigation, auth)? Do the files, components and routes it names still exist as named?               |
| 📝 **Decision log**       | Key decisions recorded in the handoff? Locked and tentative clearly marked?                                                                           |

The project's file adds its own checks under each dimension (its copy definitions file, its
component library, its token source).

## Verdicts

| Verdict       | Meaning                            | Next step                                                         |
| ------------- | ---------------------------------- | ----------------------------------------------------------------- |
| ✅ **Green**  | Ready as-is                        | Plan PR                                                           |
| 🟡 **Yellow** | Ready with eng-side clarifications | Plan PR records each clarification as a decision                  |
| 🟠 **Orange** | Small Design round-trip needed     | Ask Design for an addendum (with the user's yes); UI waits for it |
| 🔴 **Red**    | Significant gaps                   | Back to Design for a new round (with the user's yes); UI waits    |

A gap is Orange or Red only when the handoff truly does not cover it: a missing state, a screen
not drawn, a contract the backend cannot meet. An ambiguity the handoff's own patterns settle is a
Yellow clarification, resolved from the nearest drawn pattern. Wording is never a Design gap: it
goes to `copy-review`.

## Output: READINESS.md

Written next to the handoff (`<handoff folder>/READINESS.md`; an addendum's audit as
`READINESS_<addendum>.md`), committed in a doc PR before the plan PR:

```markdown
# Readiness Review — <Feature Name>

**Verdict:** ✅ Green / 🟡 Yellow / 🟠 Orange / 🔴 Red
**Audited:** YYYY-MM-DD
**Related ticket(s):** #N (and any addenda)
**Plan PR target:** <repo-relative path or "TBD">

## Summary

One paragraph: what is ready, what is not, what happens next.

## Per-dimension findings

### 🗺️ Scope clarity

- [✅/🟡/🟠/🔴] <observation>

### 🎭 State coverage

...

(all seven dimensions, each with at least one line)

## Gaps requiring a Design round-trip (Orange/Red only)

- Gap 1: <what is missing, and the question for Design>

## Eng-side clarifications (Yellow only)

- Item 1: <the decision the plan PR will make, and the drawn pattern it follows>

## Decisions inherited

Anything locked in the handoff, or ruled by the user, that the plan must respect.
```

## Red flags

| Thought                                      | Reality                                                                |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| "This handoff predates the audit process"    | No exemptions. Older handoffs drift most.                              |
| "It's a small screen, skip the audit"        | Small screens still name states the API may not return.                |
| "I'll note the gaps in the plan instead"     | Orange and Red stop UI work; a plan note does not ask Design anything. |
| "Every mismatch is a gap for Design"         | Only what the handoff truly does not cover. Ambiguity is Yellow.       |
| "I helped write this handoff, I'll audit it" | A cold reader is the point. Use a fresh subagent.                      |
