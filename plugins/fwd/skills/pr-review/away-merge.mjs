#!/usr/bin/env node
// The away-window merge rule. While the user is away nobody is watching a merge, so the ways to
// merge without a green check read at that moment are closed: auto-merge, an admin bypass and a
// merge queue all land a PR later, or past a failing check, on a decision made earlier.
//
// pr-gate.mjs is the one caller: the hook hands it the flags (`--merge-flags auto,admin,queue,api`)
// and the gate refuses. This rule only ever adds a refusal. It never allows anything the gate would
// refuse, and a present user sees no change at all.
import { awayState } from '../../lib/away.mjs';

const WHAT = {
  auto: '`--auto` (auto-merge)',
  admin: '`--admin` (bypassing the merge requirements)',
  queue:
    'a merge queue or auto-merge mutation, or a GraphQL call whose query cannot be read',
  api: 'a merge made through the API instead of `gh pr merge` (GraphQL mergePullRequest, REST PUT .../merge)',
};

// The refusal for these flags, or null when the merge may go on to the gate's other rules.
export function awayMergeRefusal(flags, env = process.env, now = Date.now()) {
  const asked = [...new Set(flags)].filter((f) => f in WHAT);
  if (asked.length === 0) return null;
  const state = awayState(env, now);
  if (state === 'present') return null;
  const why =
    state === 'away'
      ? 'The user is away (the away window is open)'
      : 'The away window file cannot be read, so it is treated as open';
  return (
    `${why}, and this merge uses ${asked.map((f) => WHAT[f]).join(' and ')}. ` +
    'While the user is away a merge must be judged on a check you can see now, because these forms land the PR ' +
    'later or past a failing check, with nobody watching. Do one of two things: wait for the user to return, ' +
    'or merge normally (no auto, admin or queue) once CI is green on the current head. ' +
    'The away window never widens what a merge may do.'
  );
}
