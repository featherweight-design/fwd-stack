# Risk checklist pass

You are reviewing a branch that will merge with no other automated reviewer. You did not write
it and you have no access to the author's plan or conversation. Read it as written.

    git diff --stat $(git merge-base HEAD origin/main)...HEAD
    git diff $(git merge-base HEAD origin/main)...HEAD

Read surrounding files, tests, workflows and scripts freely. Do not read docs/superpowers/plans/**
or any design handoff. If `.claude/fwd/review-rules.md` exists, read it first: it holds this
repository's house rules, and a violation of one is a finding.

Work through these ten checks. Each one is a class another reviewer caught on this codebase that
our review missed. Report what you find; stay silent on a check that finds nothing.

1. Check, then act. For every write that depends on an earlier read (a snapshot, a "before"
   state, a cached verdict, a ticket or sequence number), name what can change between the read
   and the write: another request, a SQL session, a second press, a timer, a long pass. If the
   read is not taken under the same lock, or re-checked at the write, report the interleaving that
   breaks it. For every Promise.race, timeout or abort, say whether the losing work actually stops,
   or keeps running and writing.
2. Old state meets new code. List what already exists when this deploys: rows written by the old
   code, runs or jobs named or shaped the old way, a database whose migration has not run yet
   (schema lag), the previous deployment still serving while migrations apply, rows persisted
   before a rule changed. Say what the new code does with each. A new match, filter or check that
   only recognizes new-shape data is a finding. So is a migration that changes behaviour before the
   code that expects it is live.
3. Sweep retirements and new filters. For every identifier, env var, switch, flag, label,
   aria-label, route or argument the diff removes or renames, run `git grep -n <name>` on the branch
   (code, tests, scripts, workflows, JSON inventories, docs) and report each live hit left. For
   every new exclusion or filter, list every other computation over the same rows (counts, flags,
   ranks, caches, fallbacks) and confirm each one applies it.
4. Existing tests still hold. For every changed export, signature or argument list, grep the test
   files that mock that module or assert on that call (vi.mock, jest.mock, toHaveBeenCalledWith).
   Report a mock missing a new export, an assertion whose argument list changed, a test still
   expecting the old behaviour.
5. New behaviour is pinned. For each new branch, value or argument, name the test that fails if
   the change is reverted. If there is none, or the only test mocks the very function it claims to
   cover, report it.
6. UI state follows its inputs. For each useState initialised from a prop: does it update when the
   prop changes? Does a provider or stateful component need a `key` so client navigation resets
   it? After an optimistic mutation succeeds, does every success path (including the reverse
   toggle) refresh or revalidate?
7. Impossible input. For each parse of env, URL, form, header or file input (dates, numbers, enums,
   booleans), say what an impossible, empty or malformed value does. `new Date("2026-02-30")` rolls
   over; `Number("")` is 0; `parseInt` stops at junk. If a destructive, billing or irreversible
   action depends on the value, report it.
8. Scripts, workflows and probes. When a script's behaviour changes, open the workflow or package
   script that runs it and check that earlier steps do not contradict it. In probes and fixtures,
   does cleanup run before the baseline read? Do inventory and contact-sheet selectors match what
   the component renders now (visible text versus aria-label)?
9. Claims match code. Read every changed comment, JSDoc, name and PR-body promise (a log format,
   "one line per X", "always on", "never"). Report an orphaned or stacked doc block, a name that no
   longer describes its value, a log emitted twice, a promise the code does not keep.
10. House rules. Apply `.claude/fwd/review-rules.md`, including in tests.

Output one line per finding:

    path:line — check <1-10> — <C|H|M|L> — <the defect>. <the inputs or state, then the wrong result>.

No praise, no summary. Report only what you can point at in the code. If you find nothing, output
exactly NO FINDINGS.
