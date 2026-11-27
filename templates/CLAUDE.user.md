<!--
  Append this to ~/.claude/CLAUDE.md. If the file exists, add it at the end; never overwrite the
  file. machine/switch.sh creates ~/.claude/fwd, the stable path used below.
-->

## PR review and PR structure

The full policy lives in the `pr-review` skill (`~/.claude/fwd/skills/pr-review/SKILL.md`).
Invoke it before reviewing or landing any PR. Nothing else restates it.

Run the gate rather than recalling the state:
`node ~/.claude/fwd/skills/pr-review/pr-gate.mjs <pr> --action merge`. A PreToolUse hook runs it
before `gh pr merge` and denies the call when a rule forbids it.
