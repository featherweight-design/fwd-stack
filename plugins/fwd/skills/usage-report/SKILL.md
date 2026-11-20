---
name: usage-report
description: >-
  Use when the user asks what is using their Claude subscription's weekly allowance, when limits run
  out or top-ups are being bought, or for the weekly usage line in a cost report. Splits Claude
  Code's usage by project, model, main session vs subagent, day and session, from local transcripts
  only.
---

# usage-report

The weekly allowance is shared by Claude Code, claude.ai chat and Claude Design. Only Claude Code
leaves a log on this machine, so this report covers Claude Code alone: chat and Design are not
observed. Its shares are of a weighted token count, not of the allowance, so they cannot be
subtracted from the meter in claude.ai's usage settings (or `/usage`) to find what chat and Design
used. Read the meter for the total, and this report for where Claude Code's part goes.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/usage-report/usage-report.mjs" [--days 7] [--top 10]
```

It reads `<config>/projects/**/*.jsonl`, costs no model tokens, and prints markdown.

## Reading it

- **Shares are a proxy.** Anthropic does not publish how the weekly limit is computed, so turns are
  weighted the way API prices relate (input 1, cache write 1.25, cache read 0.1, output 5).
  Compare shares, not absolute numbers.
- **The costliest sessions table is where the levers are.** A session's cost per turn grows with
  its context, because every turn re-reads all of it. A median context of 300k or more across
  hundreds of turns is the usual cause of running out.
- **What to change** (report it to the user, do not change it yourself):
  - The machine compacts at 300k (`"autoCompactWindow": 300000` in `~/.claude/settings.json`); a
    median near 1M means it is unset (`run-project` §6).
  - A session that has compacted several times and drifts rotates (`orchestrator` §7).
  - Lanes and subagents on Sonnet, Opus only with a reason in the brief (`run-project` §5,
    `maxOpusLanes`).
  - Fewer parallel lanes if the allowance is the constraint (`maxLanes`).
