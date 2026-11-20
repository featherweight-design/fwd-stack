# pr-review reference

Procedures, snippets and evidence that SKILL.md links to. Read a section only when SKILL.md sends you here.

## Evidence behind the rules

- **Change freeze (from 2026-09-18).** Do not add or tune a rule without new measured evidence. A single case with a clear cause is good evidence for a fix and poor evidence for a threshold.
  - The gate is big enough to be its own risk: defects were found in it (`truncate` matching a Tailwind class, `productIsTooling` satisfied vacuously by a docs-only PR). Fix gate defects freely; adding rules is what is frozen.
  - Agreement between concurrent agents (same app, day, model) is one observation, not independent evidence.
- **The 2026-11-08 change.** Over risky PRs that ran a second, external reviewer alongside Claude from 2026-10-30, that reviewer found 33 real defects Claude's review missed, across 15 PRs (3 High, 15 Medium, 15 Low), in ten classes, one check each in `risk-checklist-prompt.md`: check-then-act races (4), old state meeting new code (5), a retirement or filter not swept to siblings (5), a change breaking an existing test (3), new behaviour no test pins (3), UI state not following its inputs (3), scripts/workflows/probes out of order (4), a comment/name/claim the code does not match (4), parsing that accepts impossible input (1), a house rule only the other reviewer had been told (1). 22 of 33 sat outside the diff. Add or tune a check only on a class that escapes more than once.
- **Split on file count.** Review surface is per-file: over 30 PRs, review passes correlated with file count (+0.73) and not at all with line count (0.00). A 5,792-line, 12-file PR took one pass; a 1,096-line, 38-file PR took eleven.

## Confirm the push landed

A chained `git rebase && git push && gh api …` short-circuits silently. One call catches a failed push, rebase or rejected `--force-with-lease`; the gate runs it from a checkout of the PR's head branch:

```bash
[ "$(gh api repos/OWNER/REPO/pulls/N --jq .head.sha)" = "$(git rev-parse HEAD)" ] || echo "NOT PUSHED"
```

## Writing the PR body (REST)

`gh pr edit --body-file` can write nothing on some repository configurations (a GraphQL Projects error) while looking successful. Write with REST and read back:

```bash
gh api -X PATCH repos/OWNER/REPO/pulls/N -f body="$(cat prN-body.md)"
gh pr view N --json body --jq .body | grep -c "<a phrase from the entry>"
```

Name every scratch file after its PR or task (`pr<N>-body.md`), never a generic `pr-body.md`, because subagents share one scratchpad; read the file back and check it is this PR's before writing a body from it.

## Pre-open items 1-5 (the author's own checks)

1. Every raw `sql` template gets a probe before the PR opens; typecheck cannot see inside a template literal. If a query is worth writing by hand, it is worth running once.
2. Never hand-roll a query when a loader exists: grep for a reader of the same table before writing SQL.
3. Load the real route, not the component: routes have gates (an empty-state return) that components do not.
4. Verify a structural claim before writing it down; if a sentence asserts something is impossible, prove it or soften it.
5. Build the acceptance artifacts (contact sheet) before opening: a phone with none of the feature is visible in one glance.

## The cold-eyes precheck trial: scoring

Dispatch needs the user's subagent authorization (a project grants it standing in `AGENTS.md`/`CLAUDE.md` or `.claude/fwd/pr-review.md`; otherwise ask once, and skip the pass if declined; the grant covers this pass only). Use a general-purpose subagent, never a fork, with `precheck-prompt.md` as its prompt, branch only, no plan or handoff. It is a weaker reviewer than a full review pass (same model family); its job is to strip mechanical findings. Verify every finding before acting; it never gates the PR.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/pr-review/precheck.mjs" record <file>   # or - for stdin
node "${CLAUDE_PLUGIN_ROOT}/skills/pr-review/precheck.mjs" score <pr> <predicted> <first-review-total> --fixed=N --shipped=M --kind=K [note]
```

The ledger lives in the plugin's data folder (`~/.claude/plugins/data/fwd-fwd-stack/`, or under `CLAUDE_CONFIG_DIR`), never beside the scripts: it holds finding text from private repositories. A PR's first `score` runs in a checkout of its branch; re-scoring can run elsewhere with `--repo=owner/name`.

- Run it on EVERY PR while the trial is open; a self-selected sample cannot answer the trial's question.
- `--fixed=N` is the number that matters: the pass's findings you fixed before opening. A pre-open fix never reaches the first review, so the `predicted/first-review` hit rate scores zero when the pass worked best. The ledger never divides one by the other.
- `--shipped=M` counts DEMONSTRATED reach (something consumed the defect), not plausible reach; on prose, zero unless a consumer quoted it.
- `--kind` is the PR's risk: `arithmetic`, `layout`, `modelling`, `wiring`, `prose`. The ledger withholds a verdict while every scored PR is one kind.
- Do not change `precheck-prompt.md` while the trial is open: before and after rows measure different instruments.
- Hypothesis to test once kinds are in: the pass misses an ABSENCE spanning two files (a cost drawn but never spoken, a payload whose destination is in another module) and hits what is visible inside one file.
- At three scorable PRs of at least two kinds the ledger prints a verdict: 70% or more cuts the pass to one confirmation, 30-70% keeps both, under 30% means read it with the pre-open fix count before recommending deletion. Bring the verdict to the user; the section stays a trial until it exists.

## Escape tracking (until 2026-11-30)

`node escape-sweep.mjs --repo owner/name [--repo ...] --since YYYY-MM-DD [--json]` from this skill's folder lists items 1 and 2 per repo, judging risk by the gate's own path rule and ignoring overlap on docs, tests, generated, handoff and tooling files.

## Draining a stack that already exists

Bottom-up, one PR under review at a time; no review on a child while its parent is open. After a squash-merged parent, rebase the child onto main:

```bash
git rebase --onto origin/main <parent-branch> <this-branch>
gh pr edit N --base main
```

Then confirm the diff shrank to this PR's own work (`gh pr view N --json changedFiles,additions`).

## Splitting a plan

The natural cut is the plan's task groups: (1) data (columns, transform, ingest, migration), (2) pure model, (3) read path and copy, (4) routes and components, (5) severable extras, each its own PR. If tasks genuinely cannot be cut, say so and get agreement before starting.
