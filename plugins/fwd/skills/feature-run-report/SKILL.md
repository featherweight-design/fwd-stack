---
name: feature-run-report
description: Use at the end of an autonomous multi-PR feature run (epic-run, spec→plan→impl chain, or any overnight PR sequence) to produce the "Morning report" summary format. Always invoke when the last PR of a run is merged AND the loop is winding down — never invoke mid-run.
---

# feature-run-report

**First, read the project's own rules.** If `.claude/fwd/feature-run-report.md` exists in the project, read
it before anything else: it names the project's own tools and conventions for this skill, and
its rules add to these and win where they conflict.

Produces the "Morning report" summary the user reads first thing after an autonomous overnight run. Format is fixed — divergence loses signal.

## When to invoke

- Final PR of an autonomous run has merged.
- Session cleanup is done (worktrees pruned, test DBs dropped, the run's checkpoint note updated).
- The loop is about to end (or has ended) and no further work is queued.

**Not for:** single-PR sessions, mid-run status updates, "check-in" messages between merges. Those are their own thing.

## Output shape

```markdown
☀️ **Morning report — <epic name> <status>**

Morning — <1–2 sentences: what shipped overnight; whether it needed intervention; the single most important status fact>.

**Progress:** <N of M planned PRs merged> · <milestones reached, one short clause each>

## Needs your input

<always include; first after the opener. Decisions only you can make, each with a recommendation and what is blocked until you answer. Say "nothing" explicitly when clear.>

## What shipped, per PR

| PR           | What                                            | Copilot callouts                                                                                                    |
| ------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [#NNNN](url) | <one-line what — feature or scope in ~10 words> | <round count>; <best catches — 1–3 items, specific issues Copilot flagged that would have shipped broken otherwise> |

Release entries shipped: <version + one-line description, or "none — no user-visible change">.

## Infrastructure and environment variables

<always include this section — say "none" explicitly if the run added neither>

New services (cron jobs, workers, queues, buckets) created during the run:

| Service | Created?                                      | Environment              | Schedule / trigger     |
| ------- | --------------------------------------------- | ------------------------ | ---------------------- |
| `name`  | ✅ live / ⚠️ declared only — <what's missing> | <env group or "unhomed"> | <cron expr or trigger> |

| Name       | Where                            | Purpose    | How to get it                                               |
| ---------- | -------------------------------- | ---------- | ----------------------------------------------------------- |
| `VAR_NAME` | <which services/envs it goes in> | <one line> | <where to create it — dashboard path, never a pasted value> |

<one line on what stays broken/dormant until they're set>

## What did NOT ship (deliberately scoped down, filed as follow-ups)

<optional section — include only if you split scope during the run>

- [#NNNN](url) — <what deferred + why>

## Staging validation (agent-side, done)

- <what CI + local + smoke validation confirmed>
- <what agent-side testing covered>
- <what needs the user's device / can't be verified without human>

## How to test

<per shipped feature, the exact steps a human takes: URL, account to use, what to click, what you should see. Say what an agent already covered so the user does not repeat it, and which flows only a real device can check.>

1. <feature> — <URL> · <account> · <steps> · expect <result>

## Your checklist

<numbered list of manual actions the user needs to take, ordered by priority>

1. <action + why it matters>
2. <action + why>
3. <optional decision points if there's meaningful sequencing choice ahead>

## Cleanup all done

<one line confirming worktrees pruned, test DBs dropped, checkpoint note updated, main repo clean>

Loop ended — <one-liner: nothing left / next natural checkpoint>.
```

## Rules

- **First line is the ☀️ header. Always.** The emoji is load-bearing — the user's eye finds it in the transcript when they wake up.
- **Table columns are fixed: PR / What / Copilot callouts.** Don't add columns. Don't reorder. Don't switch to a bulleted list even if there's only 1–2 PRs.
- **"Copilot callouts" leads with round count** (`8 rounds`) then the 1–3 most substantive findings — the ones that would have shipped broken had Copilot not caught them. "Doc-sync only" or "nits only" is a valid callout when rounds were clean. Never list ALL findings — the point is signal.
- **Infra + env var section is mandatory, and never contains a value.** Sweep every PR body in the run for new services AND new environment variables. For services: say plainly whether the thing actually exists at the hosting or database provider, or whether the run only _declared_ it in the project's hosting config (e.g. `render.yaml`, `vercel.json`), which may describe a service without creating it. "Declared only" is the failure mode that ships a feature into silence — a cron that was never created logs nothing, errors nothing, and pages nobody. For vars: roll them up and name the variable, the services/environments it belongs in, and the dashboard path to create it — never the secret itself. If a feature is dormant until the vars are set, say so; that's the sentence that stops the user assuming it shipped live. "None" is a valid and useful answer.
- **"What did NOT ship" section is optional and honest.** Include it iff you scoped down during the run. Frame follow-ups as issues (link them), not TODOs.
- **Staging validation must say what you didn't validate.** "Every unit test green" ≠ "feature works." If a flow can only be checked on the user's own phone (say, an install prompt or a push permission dialog), say that.
- **Proposed intake lives in the backlog audit's own report, not here.** The shape above is fixed; at most, add one checklist line such as "Review N proposed issues in the backlog-audit report".
- **Your checklist is action-ordered, not verbose.** Numbered items with one line each; skip explanations the user doesn't need. Include a decision-point item if there's a real fork ahead ("recommendation: land PR-2 and PR-4 in parallel"). Never include CI verification steps — you already did those.
- **Cleanup line is one sentence** confirming the housekeeping. If something wasn't clean, say what.
- **"Loop ended" is the last line.** It's a signal that the report is complete and the session is truly winding down.

## What NOT to do

- Don't summarize with prose paragraphs — the user reads this on their phone before coffee. Table + bullets.
- Don't include "Timeline" or "Metrics" sections (the one-line Progress count is not one). Not what they asked for.
- Don't include the plan-doc's task list. They've already forgotten the task numbers; the PR titles carry the meaning.
- Don't apologize for scope reductions. Frame them as scoping decisions with issues filed.
- Don't include Copilot round-by-round detail. Just round count + best catches.
- Don't include a "next steps" section separate from the checklist. Merge them.
- Don't include emojis anywhere except the header ☀️, the infra table's `✅ live` / `⚠️ declared only` marks, and the state ticks (✅ / 🟢 / 🟡 / 🕰️ / 📐) if referencing pipeline state.
- Don't reference PRs as bare `#NNNN` — always the full `github.com/.../pull/NNNN` URL, as a markdown link. A bare number is not clickable in most places the report is read, and is ambiguous across repositories.

## Voice

Casual openers, ONE all-caps callout allowed if the news warrants ("ALL 6 PRS ARE MERGED"), and cut roughly a third from a first draft. Where the project's extension describes the user's own voice, match it. Read the whole thing aloud once before shipping — if any sentence takes >5 seconds to parse, cut it.

## Delivery

Writing the report is not delivering it. After the report is final, send it so the user does not have
to come back to the computer to learn the run ended:

1. Save the report markdown to a file under `$CLAUDE_JOB_DIR/tmp` (or the session scratch folder).
2. Email it: `node ~/.claude/fwd/lib/send-report.mjs --subject "<subject>" --body-file <file>`.
   Subject: `[done] <epic> — <N of M merged>` when the run finished, `[needs input] <epic> — <the decision>`
   when it is blocked on the user. The script reads `RESEND_API_KEY`, `EMAIL_FROM` and `REPORT_EMAIL_TO`
   from the environment, or from `report-email.json` in the plugin data folder.
3. Ping the phone with `PushNotification`: one line, the subject plus the single most important fact.
   The email carries the detail.
4. If the email fails (missing config, Resend error), say so in the push and in the final message, and
   keep the report in the transcript. Never skip delivery silently.

Send the `[needs input]` variant mid-run too, the moment the run blocks on a decision only the user can
make, then keep working on anything unblocked.

## Related

- Any per-PR post-merge note posted mid-run is a different thing: that is a status update after one merge, this is the end-of-run summary. Don't let either borrow the other's shape.
- `epic-run` skill — the primary caller. Its "Done Means" section should end with an invocation of this skill.
