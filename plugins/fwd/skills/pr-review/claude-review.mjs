// Whether the PR body's `## Claude review` section records a review that actually ran.
//
// Split out of pr-gate.mjs so the rule can be tested without GitHub.
//
// WHY. The gate used to accept the heading alone, so a PR merged while its section said only
// "(pending)": the heading was written before the review, and the review never happened.
//
// The rule, kept loose on purpose because real records are short ("cavecrew-reviewer: no
// findings.", "One-sentence revert to the exact text of #N; no logic change."):
//   - the section is the heading line's own text after "Claude review" plus everything up to the
//     next `#` or `##` heading, with HTML comments and sub-heading lines (`### Findings`) removed;
//   - it is split into clauses at . ; : , ! ? ( ) and dashes between words, each lowercased with
//     markup and punctuation dropped;
//   - it is NOT a record when no clause is left, when the first clause opens with pending, tbd,
//     tba, todo, to do or wip ("Pending: cavecrew-reviewer"), or when ANY clause is only a
//     placeholder ("Reviewer: n/a", "cavecrew-reviewer: TBD", "None yet, will run after CI",
//     "The review is pending.", "Review still pending", "pending review"). A clause ending
//     "is pending" is a record only when a relative pronoun or clause conjunction (that, which,
//     while, ...) opens it after a subject that is not about the review (describesCode below);
//   - anything else is a record, so a finding that mentions a pending state still counts,
//     including one whose clause ends on it ("cancels a frame that is still pending").

const HEADING = /^##[ \t]+Claude review\b([^\n]*)$/im;

const PLACEHOLDER_OPENER = /^(?:pending|tbd|tba|todo|to do|wip)\b/;
const PLACEHOLDER =
  '(?:pending|tbd|tba|todo|to do|wip|n a|na|none yet|not yet run|not run yet|not yet reviewed|' +
  'not reviewed yet|not yet|coming soon|placeholder)';
const VERB =
  '(?:is|are|was|were|is still|are still|was still|still|remains|remain|has been|have been|will be)';
// The words a review-status subject is made of ("the review", "cavecrew-reviewer", "/code-review
// medium", "checklist pass"), with the fillers that come before one ("this", "our", "Claude's").
const STATUS_WORDS = new Set(
  (
    'the a an this our my its it s claude code review reviews reviewer reviewers cavecrew ' +
    'checklist pass passes finding findings result results medium low high xhigh max ultra ' +
    'copilot off security'
  ).split(' '),
);
const STATUS_WORD = `(?:${[...STATUS_WORDS].join('|')})`;
// A clause that is a placeholder alone, a subject that "is pending" / "still TBD", "review
// pending", or "pending review".
const PLACEHOLDER_CLAUSE = new RegExp(
  `^(?:(?:.+ )?${VERB} ${PLACEHOLDER}` +
    `|(?:${STATUS_WORD} )*${PLACEHOLDER}` +
    `|${PLACEHOLDER}(?: ${STATUS_WORD})+)$`,
);
// The one way out for a clause that ends "<verb> pending": prose about the code, where a relative
// pronoun or clause conjunction opens a subordinate clause after a subject that is not about the
// review ("the cleanup cancels a frame that is still pending", "stays queued while the upload is
// pending"). Time and condition words (after, before, since, once, if, when, until, as, so) are
// left out on purpose: they open status phrasing ("Review after CI is pending"). Everything else
// fails closed and stays a placeholder; a real finding can be phrased with one of these words.
const SUBORDINATE =
  /^(.+?) (?:that|which|while|whose|who|because|although|though|whereas|unless|whether) /;
const describesCode = (clause) => {
  const m = SUBORDINATE.exec(clause);
  return !!m && m[1].split(' ').some((w) => !STATUS_WORDS.has(w));
};
const isPlaceholderClause = (clause) =>
  PLACEHOLDER_CLAUSE.test(clause) && !describesCode(clause);

/** Whether a section's clauses hold a real record: some clause, no placeholder opener or clause. */
const isRecord = (parts) =>
  parts.length > 0 &&
  !PLACEHOLDER_OPENER.test(parts[0]) &&
  !parts.some(isPlaceholderClause);

/** The text a `## Claude review` record must hold, said where the gate refuses it. */
export const RECORD_HINT =
  'write the reviewer and what it found, e.g. "cavecrew-reviewer: no findings." or ' +
  '"cavecrew-reviewer: 2 findings (1 Medium, 1 Low), both fixed."';

const clauses = (text) =>
  text
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/^[ \t]*#{3,}(?:[ \t].*)?$/gm, ' ')
    .split(/[.;:,!?()\n]|\s[-–—]+\s/)
    .map((c) =>
      c
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim(),
    )
    .filter(Boolean);

/**
 * `{ present, recorded, text }` for the section a heading regex opens: `present` when the heading
 * exists, `recorded` when its section holds a real record (the rule above), `text` the section's
 * own words, trimmed. Group 1 of `heading` is the heading line's own text after the fixed words.
 * Shared with risk-override.mjs, so a `## Risk: not risky` reason passes the same placeholder test.
 */
export function sectionState(body, heading) {
  const text = body ?? '';
  const m = heading.exec(text);
  if (!m) return { present: false, recorded: false, text: '' };
  const rest = text.slice(m.index + m[0].length).split(/^#{1,2}[ \t]/m)[0];
  const own = `${m[1] ?? ''}\n${rest}`;
  const parts = clauses(own);
  const recorded = isRecord(parts);
  return {
    present: true,
    recorded,
    text: own
      .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  };
}

/**
 * `{ present, recorded }` for a PR body: `present` when a `## Claude review` heading exists,
 * `recorded` when its section holds a real record (see the rule above).
 */
export function claudeReviewState(body) {
  const { present, recorded } = sectionState(body, HEADING);
  return { present, recorded };
}

// OWNER RULING 2026-11-08: Copilot is off. A risky PR meets its bar with no Copilot round when the
// body carries a `## Copilot off` heading AND its `## Claude review` records both passes the ruling
// asks for: `/code-review` (named anywhere in the section) and a `Checklist pass:` line whose own
// text is a real record by the rule above ("Checklist pass: no findings." counts,
// "Checklist pass: pending" does not). Both are looked for inside the Claude review section only, so
// a later section cannot stand in for either.
const COPILOT_OFF = /^##[ \t]+Copilot off[ \t]*$/im;
const CHECKLIST =
  /^[ \t>*_-]*(?:\*\*|__)?Checklist pass(?:\*\*|__)?[ \t]*:([^\n]*)$/im;
const CODE_REVIEW = /\/code-review\b/;

/** The text a risky `## Copilot off` record must hold, said where the gate refuses it. */
export const COPILOT_OFF_HINT =
  'under `## Claude review`, name `/code-review medium` and what it found, then a line ' +
  '"Checklist pass: <n> findings (C/H/M/L), <what was fixed>" or "Checklist pass: no findings."';

/**
 * `{ declared, codeReview, checklist, opens, missing }` for a PR body. `declared` when the
 * `## Copilot off` heading exists; `codeReview` and `checklist` when the Claude review section
 * records each pass; `opens` when the heading is declared and the section is a real record holding
 * both; `missing` names what is not there yet, in the order to fix it.
 */
export function copilotOffDoor(body) {
  // Everything inside an HTML comment is invisible, headings included: a commented-out
  // `## Copilot off` or `## Claude review` declares and records nothing. CRLF bodies (web edits)
  // are read as LF, so a heading's line end still matches.
  const text = (body ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ');
  const declared = COPILOT_OFF.test(text);
  const review = sectionState(text, HEADING);
  const m = HEADING.exec(text);
  const section = m
    ? `${m[1] ?? ''}\n${text.slice(m.index + m[0].length).split(/^#{1,2}[ \t]/m)[0]}`
    : '';
  const codeReview = CODE_REVIEW.test(section);
  const line = CHECKLIST.exec(section);
  const parts = line ? clauses(line[1]) : [];
  // The unfilled hint ("Checklist pass: <n> findings (C/H/M/L), <what was fixed>") is not a record.
  const checklist = !/<[^>\n]*>/.test(line?.[1] ?? '') && isRecord(parts);
  const missing = [
    !declared && 'the `## Copilot off` heading',
    !review.recorded && 'a real `## Claude review` record',
    !codeReview && 'the `/code-review` pass in `## Claude review`',
    !checklist && 'a `Checklist pass:` line in `## Claude review`',
  ].filter(Boolean);
  return {
    declared,
    codeReview,
    checklist,
    opens: declared && review.recorded && codeReview && checklist,
    missing,
  };
}

/**
 * The risky-PR merge bar the `## Copilot off` door decides, or `null` where the door does not apply
 * (no heading, or a PR that is not risky: those keep their own bar). With the heading on a risky PR
 * the door alone decides: a Copilot round already on the PR, or a `## Copilot budget stop`, does not
 * stand in for the two Claude passes.
 */
export function copilotOffBar(door, risky) {
  return door.declared && risky ? door.opens : null;
}
