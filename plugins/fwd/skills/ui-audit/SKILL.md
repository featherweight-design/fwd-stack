---
name: ui-audit
description: Use when auditing the project's app for pure UI breakage — horizontal overflow, unreadable wrapping, overlapping elements, broken images, crushed tap targets — across staging routes and mobile/desktop viewports. Report-first; nothing files without user approval.
---

# ui-audit

**First, read the project's own rules.** If `.claude/fwd/ui-audit.md` exists in the project, read
it before anything else: it names the project's own tools and conventions for this skill, and
its rules add to these and win where they conflict.

## Overview

On-demand UI sweep of the project's staging environment: run the project's Playwright sweep engine, triage the captures via vision subagents for pure UI breakage, present the findings to the user, and — only after explicit approval — file GitHub issues with resolving screenshots.

**What the project supplies:**

- **The sweep command** is `uiSweep` in `.claude/fwd.json` (for example `"uiSweep": "pnpm --filter e2e audit:sweep"`). The contract: this skill appends at most one argument, `--tags=<tag,...>`, to the end of that string, and the command prints a `SweepResult` JSON with a `runId`. If the project's runner needs a separator before forwarded arguments (for example `npm run` needs `--`), put the separator inside the `uiSweep` string itself (`"npm run audit:sweep --"`) so the appended `--tags=` reaches the engine.
- **`.claude/fwd/ui-audit.md`** names: the sweep engine's location and the marker file that proves the clone is right, the output directory (`<outDir>` below), the prod guard, the preflight checks (staging data population, fixture users) and their seed commands, the route tags and how routes split into triage buckets, the issue label set (no priority label in it) and the severity-to-priority-label mapping, and any gotchas of the sweep command.

**If `uiSweep` is missing, stop.** Report that the project has no sweep command configured and that the audit cannot run. Never guess a command, and never improvise a sweep by hand.

**A screenshot finds; a probe proves.** The sweep's captures are screens at rest, so they catch
layout breakage but never behaviour. Every approved finding's issue names the probe its fix must
ship with (`ui-probe` skill): the claim, the widths, and what to measure. The fix is done when that
probe fails on the old code and passes on the new. Behaviour the captures cannot show (focus, a
tap, a scroll, a sheet) is probed directly, never inferred from a picture.

**Announce at start:** "I'm using the ui-audit skill to sweep staging."

---

## When to Use

**Invoke when the user says:**

- "Run the audit skill"
- "Check for mobile breaks"
- "Ui audit" / "Run ui audit"
- "Sweep the admin routes for layout issues"

**Do NOT invoke for:**

- Dark-mode / light-mode drift (single-theme audit only)
- UX judgment ("is this the right button copy") — audit is layout-only
- Pixel-diffs against a design handoff (use `design-review` skill instead)
- Prod scanning — the sweep never targets prod (the extension names the guard that enforces it; if the project has no such guard, confirm the base URL is not prod before running)

---

## The Judgment Bar (Pure UI Breakage)

Only file findings that fit these classes. Anything else — even a real defect — stays out of the report.

| Class        | What it is                                                                                 | Example                                             |
| ------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `overflow`   | Content pushes past the viewport / container edge                                          | Table extends right edge; horizontal scroll appears |
| `wrap`       | Text wraps one char per line, or breaks mid-word unreadably                                | A narrow table column on 320px                      |
| `overlap`    | Two independent elements sit on top of each other                                          | Toast covers a modal button                         |
| `image`      | `<img>` failed to load (naturalWidth=0 in a real browser)                                  | Broken thumbnail                                    |
| `tap-target` | Interactive element smaller than 24×24 CSS px (WCAG 2.2 AA 2.5.8; 44×44 is the AAA target) | Icon button crushed at mobile size                  |

Severity:

- `balk` — the render is broken enough that a real user would abandon the task
- `degraded` — visible defect but the task still completes

---

## Preflight (before every run)

1. **Verify the repo is present and up-to-date.**

   ```bash
   REPO_DIR="${REPO_DIR:-$(git rev-parse --show-toplevel)}"
   test -f "$REPO_DIR/<marker file named by the extension>" || { echo "run this from the project's clone"; exit 1; }
   git -C "$REPO_DIR" fetch origin main
   ```

   If main is behind, prompt the user before pulling — audits should target what's actually deployed to staging.

2. **Confirm staging is populated.** Run the data-population check the extension names. If it reports below its threshold, PROMPT the user: "Staging looks unseeded (<what the check found>). Run `<seed command from the extension>` first — otherwise every capture will be marked `insufficientData` and the triage skips it. Continue anyway?" If the extension names no check, record that in the report's "Integrity notes" section and continue.

3. **Confirm the fixture users are provisioned.** Run the fixture check the extension names. If fixtures are still placeholders, skip the auth-required routes it lists, warn the user that the audit is unauthenticated-only until fixtures land, and record the skip in the report's "Integrity notes" section. If the extension names no fixture check, record that there too.

---

## Run the sweep

**From the repo root (or any worktree)**, with `SWEEP` set to the `uiSweep` value. Run it through `eval` with the whole string quoted: an unquoted `$SWEEP` is not word-split in zsh, so it would run as one long command name. If `uiSweep` is missing, the check below stops the run: tell the user and do not continue.

```bash
SWEEP=$(node -p "require('$(git rev-parse --show-toplevel)/.claude/fwd.json').uiSweep")
if [ -z "$SWEEP" ] || [ "$SWEEP" = "undefined" ]; then
  echo "ui-audit: no uiSweep command set in .claude/fwd.json; add one before running the sweep." >&2
  exit 1
fi

# Tag-scoped run when the user specified tags:
eval "$SWEEP --tags=admin"

# Full sweep when they didn't (NEVER send empty --tags=):
eval "$SWEEP"
```

**Empty tags:** if the user says "audit consumer routes but skip admin", pass the positive tag (`--tags=consumer`). NEVER pass `--tags=` alone or `--tags=""` — an empty tag list can reach the parser as `[""]` and filter wrongly. Stay defensive even if the engine handles it.

**Capture the run id from stdout** — the sweep prints a `SweepResult` JSON with `runId: "<ISO-timestamp>"`. All artifacts land under `<outDir>/<runId>/`.

---

## Vision triage

**Dispatch parallel subagents — one per tag section.** The extension names the buckets (for example, admin routes versus everything else). With none named, bucket by route tag.

Each subagent gets:

1. The triage brief from `triage-brief-template.md` in this skill's folder
2. Screenshot paths (absolute) for its bucket
3. Heuristic JSON path alongside each screenshot (`.png` → `.json`)

**The subagent must NOT file anything to GitHub.** The template repeats this. The orchestrator (this skill) is the only thing that touches `gh`.

**Skip `insufficientData: true` captures.** The sweep marks these; triage should treat them as "seeder not run" and never generate findings for them.

Findings return in this exact JSON shape (from `triage-brief-template.md`):

```json
{
  "findings": [
    {
      "routeId": "settings",
      "viewport": "320x568",
      "state": "expand-first-card",
      "severity": "balk",
      "class": "wrap",
      "oneLiner": "Detail column wraps one character per line at mobile widths.",
      "screenshotPath": "<outDir>/<run-id>/settings__expand-first-card__320x568.png"
    }
  ]
}
```

Concatenate all subagent results into one findings array.

---

## Dedupe

**Within-run collapse.** One root cause across multiple viewports/states = one finding. Group by `(routeId, class)` and keep the smallest viewport as the representative (mobile break is the worst case). Prepend the merged viewport list to `oneLiner`.

**Cross-run dedupe.** Fetch open `ui-audit` issues:

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
gh issue list --repo "$REPO" --label ui-audit --state open --json title,body --limit 100
```

For each finding, compute a fingerprint `<routeId>::<class>::<severity>`. Drop findings whose fingerprint substring-matches an existing issue's title (they use the same format — see Filing below).

---

## Report

Write `<outDir>/<runId>/REPORT.md` following `report-template.md` in this skill's folder. Also present a summary table in chat:

```
| # | Route | Class | Severity | Viewport(s) | One-liner |
|---|-------|-------|----------|-------------|-----------|
| 1 | settings | wrap | balk | 320x568, 390x844 | Detail column wraps 1 char per line |
| 2 | ... | ... | ... | ... | ... |
```

Then STOP and wait for the user's approval (see next section). Do not touch `gh`.

---

## Approval gate

**HARD STOP. No `gh` mutations before the user's explicit go-ahead.**

Ask the user one of:

1. "File all N findings"
2. "File only #1, #3" (subset)
3. "Skip #2, file the rest"
4. "Skip filing this time — I'll fix these directly"

### Rationalization table — do NOT act on these

| Thought                                                   | Reality                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------ |
| "The findings look clear-cut, I can just file them"       | STOP. The user reviews every finding before filing.                      |
| "The user asked for an audit — filing is implied"         | It is not. Report → approval → file is the fixed flow.                   |
| "Only one finding, low risk to file"                      | STOP. Volume is not the gate; approval is.                               |
| "The previous audit filed, this one should match"         | Each audit is independently approved.                                    |
| "I'll draft the issue bodies to save time, not open them" | Drafts stored in report only. No `gh api /issues` calls before approval. |

---

## Filing (after approval only)

**For each approved finding:**

### Step 1 — Upload the screenshot to the orphan artifacts branch

The `ui-audit-artifacts` branch is a repo-owned artifact store. Never merged. In a public repository, screenshots on it resolve at `raw.githubusercontent.com` for issue bodies. A private repository's raw URLs need a token, so there use the authenticated blob link (`https://github.com/$REPO/blob/ui-audit-artifacts/<path>?raw=true`), which renders for anyone with access. Never put a token in a URL.

Anchor the artifacts worktree on the **main checkout**, not on whichever worktree you are in: a path built from `git rev-parse --show-toplevel` would nest the artifacts worktree inside the current worktree, and the existence check would miss one created from elsewhere. Make sure `.worktrees/` is git-ignored in the project.

```bash
REPO_DIR="${REPO_DIR:-$(git rev-parse --show-toplevel)}"   # where the sweep ran (holds <outDir>)
MAIN_DIR=$(git worktree list --porcelain | sed -n '1s/^worktree //p')   # the main checkout
ARTIFACTS="$MAIN_DIR/.worktrees/ui-audit-artifacts"
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

# One-time (idempotent): ensure the orphan branch and its worktree exist.
if ! git -C "$MAIN_DIR" worktree list --porcelain | grep -qxF "worktree $ARTIFACTS"; then
  if git -C "$MAIN_DIR" show-ref --verify --quiet refs/heads/ui-audit-artifacts \
    || git -C "$MAIN_DIR" fetch origin ui-audit-artifacts:ui-audit-artifacts 2>/dev/null; then
    git -C "$MAIN_DIR" worktree add "$ARTIFACTS" ui-audit-artifacts
    # A branch fetched into a local ref has no upstream; set it, or the bare push below fails.
    git -C "$ARTIFACTS" branch --set-upstream-to=origin/ui-audit-artifacts
  else
    # First run anywhere: create the orphan branch (needs git 2.42+ for --orphan).
    git -C "$MAIN_DIR" worktree add --orphan -b ui-audit-artifacts "$ARTIFACTS"
    git -C "$ARTIFACTS" commit --allow-empty -m "chore: init ui-audit-artifacts orphan branch"
    git -C "$ARTIFACTS" push -u origin ui-audit-artifacts
  fi
fi

# Per approved finding: copy the screenshot into the artifacts worktree, commit, push.
git -C "$ARTIFACTS" pull --ff-only 2>/dev/null || true
mkdir -p "$ARTIFACTS/<runId>"
cp "$REPO_DIR/<outDir>/<runId>/<file>.png" "$ARTIFACTS/<runId>/"
git -C "$ARTIFACTS" add "<runId>/<file>.png"
git -C "$ARTIFACTS" commit -m "ui-audit: <runId>/<file>.png"
git -C "$ARTIFACTS" push
```

The screenshot URL is then, for a public repository:
`https://raw.githubusercontent.com/$REPO/ui-audit-artifacts/<runId>/<file>.png`
and for a private one:
`https://github.com/$REPO/blob/ui-audit-artifacts/<runId>/<file>.png?raw=true`

**Safety rails:**

- The `ui-audit-artifacts` branch is NEVER merged. If it ever appears in a PR to main, close the PR immediately.
- Never `git push --force` to `ui-audit-artifacts` — its history is the artifact record.
- Only `.png` files land on this branch. No source code, no report markdown.

### Step 2 — Open the GitHub issue

```bash
gh api -X POST "/repos/$REPO/issues" \
  -f title="ui-audit: <routeId>::<class>::<severity> — <viewport>" \
  -f body="$(cat <<EOF
## What breaks
<oneLiner>

**Where:** \`<routeId>\` at \`<viewport>\`, state \`<state>\`
**Class:** \`<class>\` — **Severity:** \`<severity>\`

## Repro
1. Set viewport to <viewport>
2. Navigate to the route
3. If interaction state != default, perform: <interaction description from the sweep's route definition>

## Probe the fix ships with
<the claim as the user would see it>, at <widths>: measure <what: a box, focus, scrollWidth against clientWidth, a computed style>. It must fail on today's code (`ui-probe` skill).

## Evidence
![screenshot](<the screenshot URL from Step 1>)

---
_Filed by \`ui-audit\` skill. Run id: \`<runId>\`._
EOF
)" \
  -f "labels[]=ui-audit" \
  -f "labels[]=<label 1 from the extension's label set>" \
  -f "labels[]=<label 2 ...>" \
  -f "labels[]=<the one priority label the severity mapping picks>"
```

Pass one `-f "labels[]=..."` per label, double-quoted so a label containing a space or an apostrophe survives the shell.

**Every issue gets the `ui-audit` label, the extension's label set, and exactly one priority label.** The extension's label set never contains a priority label; the priority comes only from the extension's severity mapping (by default `balk` → the higher priority, `degraded` → the normal one), so an issue can never carry two. If the extension names no label set, file with `ui-audit` only (plus the mapped priority label, if a mapping is named) and say so in the report.

---

## Failure handling

- **Sweep errors** (`kind: 'load' | 'interaction' | 'auth'` in `SweepResult.errors`): surface these in the report's "Sweep integrity" section but never file them as ui-audit issues (they're audit-tool issues, not app issues).
- **`insufficientData: true` capture**: skip triage; add a "Skipped (thin render — run seeder)" note to the report.
- **Empty findings after triage**: report "No pure-UI-breakage findings in this sweep" in chat and stop before the approval gate — no report file, no gh mutations. Put the integrity notes, sweep errors and skipped captures in that chat message instead, so nothing the preflight or sweep found is lost.
- **`gh` filing fails mid-batch**: report which ones landed and which failed. Don't retry automatically — the user decides whether to re-run or accept the partial batch.

---

## Related files

- `triage-brief-template.md` (this skill's folder) — subagent prompt template
- `report-template.md` (this skill's folder) — pre-approval report format
- The project's sweep-engine spec, plan and open follow-ups, if the extension names them
