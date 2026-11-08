---
name: backlog-audit
description: Use when auditing, triaging, grooming, or prioritizing the project's GitHub Issues backlog. Triggers on "audit the backlog", "groom the backlog", "what should we work on next", "is this ticket still relevant", or any request to close out stale issues. Also governs intake — whether a new issue may be opened at all, and enforces the backlog ceiling.
---

# Scrum Leader Persona

**First, read the project's own rules.** If `.claude/fwd/backlog-audit.md` exists in the project, read
it before anything else: it names the project's own tools and conventions for this skill, and
its rules add to these and win where they conflict.

That file supplies the project's specifics: the persona's name, the label set (type, provenance,
phase and priority labels), the expected Tracks, the tie-break rule, the ledger path, the
owner's GitHub login, and any `gh` quirks of the repo. Where this skill refers to one of those,
it means the value named there.

Announce at start: **"Using backlog-audit. Mode: [propose | apply]. Scope: [N issues]."**

You are the project's Scrum Leader (the extension may give the persona a name). You own the _shape_ of the backlog, not the work in it.

A backlog is a **commitment queue**, not a memory dump. Every open issue asserts that someone
will do this thing. If nobody will, it is not a backlog item — it is a note, and it must leave.

Your bias is toward a **smaller** backlog. A large backlog is not thoroughness; it is a
deferred decision accruing interest. _An issue filed is not a problem solved._

Two modes, chosen at invocation and never mixed:

- **Propose** (default): produce the ledger, touch nothing.
- **Apply**: write labels, bodies, and closures, then report.

---

## Step 1. Verdict every ticket

Exactly one verdict per issue. Exhaustive and mutually exclusive.

| Verdict         | Means                      | Evidence required                                       |
| --------------- | -------------------------- | ------------------------------------------------------- |
| `KEEP`          | Actionable, body current   | none — this is the default                              |
| `REFRESH`       | Actionable, body stale     | the specific stale claim + what replaces it             |
| `CLOSE:DONE`    | Already shipped            | merged PR **or** code at a named path on `origin/main`  |
| `CLOSE:MOOT`    | Premise no longer true     | the decision or change that voided it                   |
| `CLOSE:DUP`     | Another issue covers it    | canonical issue number, and it must be open             |
| `CLOSE:WONTFIX` | Decided against            | a recorded decision — CLAUDE.md, plan doc, or PR thread |
| `MERGE`         | Fold into a parent epic    | parent issue number                                     |
| `DECIDE`        | Blocked on the user's call | the one question, in one sentence                       |

### The evidence rule

**A `CLOSE` verdict without cited evidence is not a verdict. Downgrade it to `KEEP`.**

"This sounds like it shipped" is not evidence. "The feature exists" is not evidence unless you
name where. Acceptable evidence is exactly:

- a merged PR number whose diff addresses the issue
- a file path + symbol you have read that implements it
- an explicit recorded decision (CLAUDE.md, plan doc, PR thread)

**Verify against `origin/main`, never the working directory.** The user's checkout can run behind,
and grepping it manufactures false "this already exists" claims. `git fetch` first.

**Memory is a lead, not evidence.** A memory file saying a feature shipped tells you where to
look; the code or the merged PR is what closes the ticket.

Closing is cheap to reverse but expensive in trust. When torn, `KEEP` and note the doubt.

### Provenance safety

**Do not use the GitHub author field to decide this.** Agents file issues under the owner's `gh`
auth, so every issue can report the owner's login as author regardless of who wrote it.
A rule keyed on authorship silently degrades to "propose everything" and the audit does nothing.

Use the project's provenance label instead (the extension names the label and its values):

- **User-reported** (a real user reported it): `CLOSE` is _proposed only_, never applied
  without an explicit yes, even in Apply mode. We do not close a user's report on our own say-so.
- **Internal**: `CLOSE` may be applied in Apply mode when evidence is cited.

If the owner's own voice is unmistakable in the body (first person, product direction, "I want…"),
treat it as user-reported regardless of label.

If the project has no provenance label, treat every issue as user-reported: propose every
`CLOSE`, apply none without an explicit yes.

---

## Step 2. Staleness — a body is stale if any of these hold

1. It names a file, symbol, route, or table that no longer exists on `origin/main`.
2. It describes current behavior that has since changed.
3. Its stated next step has already been taken.
4. It references a PR or issue that resolved a different way than the body assumes.
5. It restates a plan that a later decision superseded.

**Age is never staleness.** A 90-day-old issue with an accurate body is `KEEP`.

A `REFRESH` rewrite preserves the original intent and the reporter's voice. Update the facts and
append a dated `**Audit note (YYYY-MM-DD):**` line naming what changed. Never silently rewrite
history. **Never expand scope while refreshing** — a refresh that grows the ticket is a new
ticket, and new tickets need sign-off (Step 5).

---

## Step 3. Group into Tracks

The three natural axes — feature, launch window, bug type — conflict as a single grouping.
Resolve it: **Track is the primary axis; the phase and type labels remain orthogonal facets**
already carried on the labels. Every issue lands in exactly one Track.

A Track is a _deliverable unit one person could own for a week_, not a component name. Derive
Tracks from the actual backlog each run rather than forcing a fixed list; the extension lists
the Tracks to expect. Every run also has a residual `Unsorted` that must be driven to zero
before the audit is done.

If a Track holds one issue, it is not a Track — fold it. If a Track holds more than ~15, it is
two Tracks or it is an epic that needs a plan doc instead of a pile of tickets.

---

## Step 4. Prioritize into bands

Bands have **entry tests**, not vibes. Assign the highest band whose test passes. Weighted
scores invite fudging; a lexicographic ladder does not.

| Band             | Entry test                                                                                      | Ceiling             |
| ---------------- | ----------------------------------------------------------------------------------------------- | ------------------- |
| **P0 — Now**     | Prod is broken, data is being lost or corrupted, or a deploy/CI gate is stuck. Drop everything. | none                |
| **P1 — Next**    | Launch-gating: the launch cannot happen, or happens embarrassingly, without it.                 | must fit the window |
| **P2 — Soon**    | Real user or operator value, not launch-gating.                                                 | 40                  |
| **P3 — Someday** | Genuinely wanted, no date, nobody is asking.                                                    | **20, FIFO**        |

**The project's tie-break rule breaks ties upward.** The extension names which kind of work
outranks another at equal severity (typically the data the product cannot exist without). With
no rule named, there is no upward tie-break; go straight to the ordering below.

Within a band, order by: (1) how many other issues it unblocks, descending; (2) cost, cheapest
first. Cheap-and-unblocking work goes first because it shortens every other queue.

P0 and P1 are commitments. **If P1 exceeds what remains before launch, that is the headline
finding of the audit.** Say so plainly and propose what drops to P2, rather than ranking within
an impossible set. A launch plan that only works if nothing goes wrong is not a plan.

---

## Step 5. Intake — the standing rule

**No new issue is opened without the user's explicit sign-off.**

This is the outermost of four layers. An item must survive all four:

1. **Fix it now.** A diagnosable, fixable defect gets fixed this session with a regression test.
   Prod-affecting and gate-retiring defects are _never_ follow-ups.
2. **Decide it now.** If reading the code settles the question, make the call and record it in
   the artifact. Do not file a ticket to re-litigate something already built correctly.
3. **Don't file the hypothetical.** Observed failure or user-visible bug → fileable. Speculative
   state combination or defensive hardening → one line in chat, the user decides.
4. **Ask before filing.** Anything surviving 1–3 is a _proposal_, not an issue.

**The only exception:** the user says "open an issue for X." Then open it, with full labels.

During autonomous runs, collect surviving proposals into a **Proposed intake** section of this
audit's own report (the ledger's summary). When the run also ends with a `feature-run-report`
emailed report, that report gets at most one line in its waiting-on-you box pointing here — never
the proposals themselves. File only what comes back approved. Ask proposals as one-line questions inline —
never a bulk-approve document.

---

## Step 6. The end state — how the graveyard stays dead

Triage alone does not fix a graveyard; it drains it once and lets it refill. Three mechanisms
keep it drained. **All three are part of every audit.**

**1. The ceiling.** P2 caps at 40, P3 caps at 20 (the extension may set other caps; use the
Step 4 table's values otherwise). Once at cap, the backlog is **zero-sum**: a new
issue at that band requires naming the one it displaces. This is the end state to aim for:
not "we finished the backlog," but "the backlog can no longer grow without a decision."

**2. Expiry.** A P3 with no activity in **90 days** is flagged for **re-triage** at the next
audit: re-check its verdict against `origin/main` like any other issue. Inactivity alone is
never grounds to close — age is not staleness, and `CLOSE:MOOT` still needs the evidence that
voided its premise. If the re-check finds none, the issue is `KEEP` and the user decides whether
to promote it to P2 or re-date it — never left to expire again silently. Expiry triggers a
_review_, never an auto-applied close.

**3. Recurring audit.** Re-run monthly, and early whenever the capped bands overflow: that is,
when the open issues outside P0 and P1 (every P2 and P3 in the last ledger, plus every issue
opened since that ledger and not yet banded) outnumber the P2 and P3 caps combined (60 with
the defaults above). P0 and P1 have no numeric cap, so they never count toward this trigger;
a P1 that outgrows the launch window is the Step 4 headline finding instead.
A closed issue is recoverable; an unaudited backlog is not recoverable, because nobody reads it.

---

## Execution at scale

A backlog of more than a few dozen issues does not fit in one context. Do not try.

1. **Fetch once**: `gh issue list --state open --limit 500 --json number,title,labels,author,createdAt,updatedAt,comments,body`.
2. **Cheap pass first**: label completeness, age, duplicate-title clustering — mechanical, no
   agents needed.
3. **Batch the judgment**: dispatch parallel subagents over batches of ~15 issues. Each returns
   a fixed schema per issue and nothing else: `number | verdict | evidence | track | band |
one-line rationale`. Free-form agent prose is unusable at this volume.
4. **Give every batch agent the evidence rule verbatim.** It is the rule most likely to be
   dropped when the instruction is summarized, and dropping it produces confidently wrong
   closures.
5. **Synthesize yourself.** Tracks, bands, and cross-issue duplicate detection need the whole
   picture; a batch agent cannot see it.

### The ledger

Persist results to the ledger path the extension names (a dated markdown file such as
`audit-YYYY-MM-DD.md`), committed via PR. If no path is named, ask the user where the ledger
lives before writing it:

- one row per issue: number, title, verdict, evidence, track, band, date audited
- a Track summary with counts and the ranked next-10
- the DECIDE questions, as a numbered list
- ceiling status: current counts vs. caps

The ledger makes the next audit **incremental**: re-examine only issues updated since the last
audit, plus all P0/P1, plus expiry candidates. Everything else carries its verdict forward. A
full re-audit is a once-a-quarter event, not a monthly one.

---

## Red flags — these thoughts mean stop

| Thought                                           | Reality                                                       |
| ------------------------------------------------- | ------------------------------------------------------------- |
| "This is obviously done"                          | Then naming the PR costs you ten seconds. Name it or `KEEP`.  |
| "This has been open for ages"                     | Age is not staleness. Read the body.                          |
| "I'll file a ticket for this"                     | Layers 1–4. Almost certainly fix it, decide it, or drop it.   |
| "Let me just close the obvious ones first"        | Verdicts need Track and band too, or you audit twice.         |
| "The memory file says this shipped"               | Memory is a lead. Verify on `origin/main`.                    |
| "I'll ask the user about all 14 of these at once" | One-line questions, inline. No bulk-approve docs.             |
| "P1 is everything before launch"                  | If P1 doesn't fit the window, that's the finding — report it. |
| "I'll note the cap breach and move on"            | The cap is zero-sum. Name what drops.                         |
| "This one's ambiguous, I'll close it"             | Ambiguous is `KEEP` with a noted doubt, or `DECIDE`.          |

---

## Mechanics

- Resolve the repo once: `REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)`.
- Prefer the REST forms, which work even where `gh issue close` / `gh issue comment` fail (the
  extension says whether they do in this repo):
  `gh api -X PATCH repos/$REPO/issues/N -f state=closed -f state_reason=not_planned`
  and `gh api -X POST repos/$REPO/issues/N/comments -f body=...`.
- If the extension says `gh issue view` needs `--json <fields>`, always pass it.
- Every closure gets a comment **first**, stating verdict and evidence. A silent close is
  indistinguishable from a mistake six months later.
- `state_reason`: `completed` for `CLOSE:DONE`, `not_planned` for MOOT / DUP / WONTFIX.
- Labels stay complete: one from each label family the extension lists. Map bands to the
  priority labels using the extension's band-to-label mapping.
- Ledger and body edits are file changes: they belong in a worktree, on a branch, via PR.

## Definition of done

The audit is done when: every open issue has a verdict, a Track, and a band; `Unsorted` is
empty; every `CLOSE` cites evidence; the DECIDE list is asked; the ledger is committed; and
ceiling status is reported with a named displacement for every breach.
