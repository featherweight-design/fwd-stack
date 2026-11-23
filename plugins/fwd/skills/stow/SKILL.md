---
name: stow
description: >-
  Use at a PR boundary, before rotating a lane or the orchestrator, and whenever compaction or a
  restart is near. Writes one short checkpoint (where the work stands, the exact next step, open
  decisions, what a fresh reader would get wrong, links) to the project's handoff location,
  replacing the previous one. Prose only: no hook, nothing committed.
---

# stow

A checkpoint is what lets a fresh session start from the middle instead of the beginning. Stow is
the habit of writing it on purpose, at moments you choose, instead of hoping the summary kept the
right things. It is a skill you run, not a hook that runs for you.

## 1 · When

- A PR merges or is handed to review, before the next piece starts (`lane` §5, step 1).
- Before a rotation, whether you are the lane being rotated or the orchestrator rotating out.
- When context is large and a compaction is likely soon.
- When a ruling, a decision or a surprise has landed that exists only in this conversation.

## 2 · Where

Read `.claude/fwd/lane.md` (lanes) or `.claude/fwd/orchestrator.md` (orchestrator) for the
project's handoff location. If neither names one, use the place the `lane` and `orchestrator`
skills already point to: where the project keeps handoffs. If that is unclear too, ask the
orchestrator (a lane) or the user (the orchestrator) once; do not invent a folder inside the repo.

One checkpoint per lane or role, named for it. **Overwrite it in place.** Do not append a new
section each time: carry forward what is still true, drop what is done, and the file stays short
enough to read in a minute.

## 3 · What goes in

Keep it to a screen or so, in plain sentences and short lists:

1. **Where the work stands:** what is merged, what is open and its state (review, CI, waiting).
2. **The exact next step:** a command, a file or a question, specific enough to start on at once.
3. **Open decisions:** what is undecided, who decides, and what is held up until they do. Rulings
   already made go here too, in a line each, so they are not re-asked.
4. **What a fresh reader would get wrong:** the trap, the stale assumption, the thing that looks
   done and is not, the check that passes for the wrong reason.
5. **Links:** PR URLs, branch names, the brief, the plan section. Links, not pasted content.
6. **Orchestrators only:** a line saying the roadmap is current as of a stated date and time
   (`orchestrator` §4, step 7), after you have actually brought it current.

## 4 · What stays out

- **Secrets:** no keys, tokens, connection strings or passwords, even partial. Name where a secret
  lives, never its value.
- **Legal detail:** no counsel advice, compliance gaps or entity details. If an item is legal, use
  a neutral title and a pointer to wherever the user keeps such material.
- **Never commit it.** The checkpoint lives outside the repo's tracked files, or in an ignored
  path. If the only available location is inside the repo, stop and ask.
- Not a log. History belongs in PRs and the ruling log; the checkpoint holds only what the next
  reader needs now.

## 5 · Finish

Re-read what you wrote as someone who has never seen this work: could they take the next step
without asking you? Fix the gaps, then say in one line where it is and what it covers. A lane
reports that line to the orchestrator in its next status message.
