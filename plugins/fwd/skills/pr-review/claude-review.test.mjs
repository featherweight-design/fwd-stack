// node --test claude-review.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  claudeReviewState,
  riskyDoor,
  RISKY_RECORD_HINT,
  RECORD_HINT,
} from './claude-review.mjs';

const body = (review) =>
  `Summary.\n\n## Claude review\n\n${review}\n\n## Settled\n\nnothing \`x.ts\`\n`;

test('a body with no Claude review heading has no review', () => {
  assert.deepEqual(claudeReviewState('Summary.\n\n## Settled\n\nnone\n'), {
    present: false,
    recorded: false,
  });
  assert.deepEqual(claudeReviewState(undefined), {
    present: false,
    recorded: false,
  });
});

test('a heading whose section says only "(pending)" is not a record', () => {
  assert.deepEqual(claudeReviewState(body('(pending)')), {
    present: true,
    recorded: false,
  });
});

for (const placeholder of [
  '',
  '   \n\n  ',
  '<!-- fill in after the review -->',
  'pending',
  '_Pending._',
  'TBD',
  'todo',
  'To do',
  'WIP',
  'n/a',
  'N/A.',
  '- [ ] pending',
  'Pending: cavecrew-reviewer on the diff',
  '<!-- reviewer -->\nTBD',
  // A placeholder anywhere in the section, not only at its start.
  'cavecrew-reviewer: TBD',
  'Reviewer: n/a',
  'The review is pending.',
  'None yet, will run after CI.',
  // Review-status phrasing around the placeholder is still a placeholder.
  'Review still pending.',
  'Review: pending',
  'cavecrew-reviewer: pending review',
  'cavecrew-reviewer: review pending',
  '/code-review medium is still pending',
  'Claude review: not yet run',
  'cavecrew-reviewer: not yet reviewed',
  'The checklist pass is TBD.',
  'Findings: TBD',
  'Results still to do.',
  // Any subject without a subordinate word keeps it a placeholder: the test fails closed.
  'This review is still pending.',
  'A review is pending.',
  'Our review is pending.',
  'Review of this PR is pending.',
  "Claude's review is pending.",
  '/code-review ultra is pending',
  'The /code-review run is pending',
  'Security review by cavecrew is pending',
  'Review was not yet run.',
  'Review has been TBD.',
  'The review will be TBD.',
  'cavecrew-reviewer: not reviewed yet',
  'Review remains pending.',
  // Time and condition words open status phrasing, not prose: still placeholders.
  'Review after CI is pending.',
  'Review since the last push is pending.',
  'Review before merge is TBD.',
  'Review as of this push is pending.',
  'Review so far is pending',
  'Code review once CI is green is pending',
  'cavecrew-reviewer: run if needed is TBD',
  'Review when CI is green is pending.',
  'Review until the rebase lands is TBD.',
  // A subordinate clause after a review-only subject is still about the review.
  'The review that runs after CI is pending.',
]) {
  test(`a placeholder section is not a record: ${JSON.stringify(placeholder)}`, () => {
    assert.equal(claudeReviewState(body(placeholder)).recorded, false);
  });
}

test('an empty section at the end of the body is not a record', () => {
  assert.equal(
    claudeReviewState('Summary.\n\n## Claude review\n').recorded,
    false,
  );
});

for (const record of [
  'cavecrew-reviewer: no findings.',
  'One-sentence revert to the exact text of #12; no logic change.',
  'Workflow-only change; one input renamed.',
  '`cavecrew-reviewer`: 0 findings, 1 question. Confirmed.',
  'Reviewer: `/code-review` medium, run before merge. 0 findings.',
  'None.',
  'No findings.',
  // A finding about a pending state is a record, not a placeholder.
  'cavecrew-reviewer: 1 Medium, the pending badge never clears. Fixed.',
  // Prose whose clause ENDS on a placeholder word describes the code, not the review.
  '/code-review medium: 1 Medium, the cleanup cancels a frame that is still pending. Fixed.',
  'cavecrew-reviewer: 1 Low, the retry stays queued while the upload is pending. Fixed.',
  'cavecrew-reviewer: 1 Medium, the export button showed while the label was TBD. Fixed.',
  'cavecrew-reviewer: 1 Low, an empty country field rendered as n/a. Fixed.',
  'cavecrew-reviewer: 1 Low, the banner stays up although the sync is not yet. Fixed.',
  'cavecrew-reviewer: 1 Low, the sweep skipped items that are still to do. Fixed.',
  'cavecrew-reviewer: 1 Medium, the poller drops a job which is still pending. Fixed.',
  'cavecrew-reviewer: 1 Low, the row hides its owner whose invite is pending. Fixed.',
  'cavecrew-reviewer: 1 Low, the toast fires because the save is pending. Fixed.',
]) {
  test(`a real record counts: ${JSON.stringify(record)}`, () => {
    assert.equal(claudeReviewState(body(record)).recorded, true);
  });
}

test('a record on the heading line itself counts', () => {
  assert.equal(
    claudeReviewState(
      'Summary.\n\n## Claude review: cavecrew-reviewer, no findings\n\n## Size\n\nsmall\n',
    ).recorded,
    true,
  );
});

test('a sub-heading inside the section stays in it', () => {
  assert.equal(
    claudeReviewState(body('### Findings\n\ncavecrew-reviewer: 1 Low, fixed.'))
      .recorded,
    true,
  );
  assert.equal(
    claudeReviewState(body('### Findings\n\n(pending)')).recorded,
    false,
  );
});

test('a bare ### line does not swallow the record under it', () => {
  assert.equal(
    claudeReviewState(body('###\ncavecrew-reviewer: no findings.')).recorded,
    true,
  );
});

test('an h1 after the section ends it', () => {
  assert.equal(
    claudeReviewState(
      'Summary.\n\n## Claude review\n\nn/a\n\n# Notes\n\nsome text\n',
    ).recorded,
    false,
  );
});

test('a later section cannot stand in for an empty review', () => {
  assert.equal(
    claudeReviewState(
      'Summary.\n\n## Claude review\n\n(pending)\n\n## Settled\n\ncavecrew-reviewer: no findings.\n',
    ).recorded,
    false,
  );
});

test('the hint says what to write', () => {
  assert.match(RECORD_HINT, /cavecrew-reviewer: no findings\./);
});

// ---- the `## Copilot off` door (owner ruling 2026-11-08) ----------------------

const off = (review, extra = '') =>
  `Summary.\n\n## Copilot off\n\n## Claude review\n\n${review}\n\n## Settled\n\nnothing \`x.ts\`\n${extra}`;

const BOTH =
  '/code-review medium: 1 Medium, fixed.\nChecklist pass: 2 findings (0/0/1/1), both fixed.';

test('the door opens on the heading plus both passes recorded', () => {
  assert.deepEqual(riskyDoor(off(BOTH)), {
    declared: true,
    codeReview: true,
    checklist: true,
    opens: true,
    missing: [],
  });
});

test('"Checklist pass: no findings." counts as a record', () => {
  assert.equal(
    riskyDoor(
      off('/code-review medium: no findings.\nChecklist pass: no findings.'),
    ).opens,
    true,
  );
});

for (const line of [
  '- **Checklist pass:** 1 Low, fixed.',
  '**Checklist pass**: NO FINDINGS',
  '> Checklist pass: 3 findings (0/1/1/1), all fixed.',
  'Checklist pass: 1 Low, the cleanup cancels a frame that is still pending; fixed.',
]) {
  test(`a decorated checklist line counts: ${JSON.stringify(line)}`, () => {
    assert.equal(
      riskyDoor(off(`/code-review medium: no findings.\n${line}`)).opens,
      true,
    );
  });
}

test('both passes without the heading do not open the door', () => {
  const door = riskyDoor(`Summary.\n\n## Claude review\n\n${BOTH}\n`);
  assert.equal(door.declared, false);
  assert.equal(door.opens, false);
  assert.deepEqual(door.missing, ['the `## Copilot off` heading']);
});

test('the heading without the checklist pass does not open the door', () => {
  const door = riskyDoor(off('/code-review medium: no findings.'));
  assert.equal(door.declared, true);
  assert.equal(door.codeReview, true);
  assert.equal(door.checklist, false);
  assert.equal(door.opens, false);
  assert.deepEqual(door.missing, [
    'a `Checklist pass:` line in `## Claude review`',
  ]);
});

test('the heading without /code-review does not open the door', () => {
  const door = riskyDoor(off('Checklist pass: no findings.'));
  assert.equal(door.codeReview, false);
  assert.equal(door.opens, false);
  assert.deepEqual(door.missing, [
    'the `/code-review` pass in `## Claude review`',
  ]);
});

for (const placeholder of [
  'Checklist pass: pending',
  'Checklist pass: TBD',
  'Checklist pass:',
  'Checklist pass: <!-- after CI -->',
  'Checklist pass: not yet run',
  'Checklist pass: still pending',
  'Checklist pass: pending review',
  'Checklist pass: run after CI is pending',
]) {
  test(`a placeholder checklist line is not a record: ${JSON.stringify(placeholder)}`, () => {
    const door = riskyDoor(
      off(`/code-review medium: no findings.\n${placeholder}`),
    );
    assert.equal(door.checklist, false);
    assert.equal(door.opens, false);
  });
}

test('a placeholder review section keeps the door shut even with both names in it', () => {
  const door = riskyDoor(
    off('/code-review medium: pending\nChecklist pass: no findings.'),
  );
  assert.equal(door.opens, false);
  assert.ok(door.missing.includes('a real `## Claude review` record'));
});

test('a checklist line in a later section cannot stand in for the review', () => {
  const door = riskyDoor(
    off(
      '/code-review medium: no findings.',
      '\n## Notes\n\nChecklist pass: no findings.\n',
    ),
  );
  assert.equal(door.checklist, false);
  assert.equal(door.opens, false);
});

test('a checklist line inside an HTML comment does not count', () => {
  const door = riskyDoor(
    off(
      '/code-review medium: no findings.\n<!-- Checklist pass: no findings. -->',
    ),
  );
  assert.equal(door.checklist, false);
});

test('a "## Copilot off" heading must be the whole heading', () => {
  assert.equal(
    riskyDoor(
      `Summary.\n\n## Copilot off until Friday\n\n## Claude review\n\n${BOTH}\n`,
    ).declared,
    false,
  );
});

test('an empty body declares nothing', () => {
  assert.deepEqual(riskyDoor(undefined), {
    declared: false,
    codeReview: false,
    checklist: false,
    opens: false,
    missing: [
      'the `## Copilot off` heading',
      'a real `## Claude review` record',
      'the `/code-review` pass in `## Claude review`',
      'a `Checklist pass:` line in `## Claude review`',
    ],
  });
});

test('the risky-record hint names both passes', () => {
  assert.match(RISKY_RECORD_HINT, /\/code-review medium/);
  assert.match(RISKY_RECORD_HINT, /Checklist pass: no findings\./);
});

test('the unfilled hint is not a checklist record', () => {
  const door = riskyDoor(
    off(
      '/code-review medium: no findings.\nChecklist pass: <n> findings (C/H/M/L), <what was fixed>',
    ),
  );
  assert.equal(door.checklist, false);
  assert.equal(door.opens, false);
});

test('a "## Copilot off" heading inside an HTML comment is not a declaration', () => {
  const door = riskyDoor(
    `Summary.\n\n<!--\n## Copilot off\n-->\n\n## Claude review\n\n${BOTH}\n`,
  );
  assert.equal(door.declared, false);
  assert.equal(door.opens, false);
});

test('a commented-out Claude review section records nothing', () => {
  const door = riskyDoor(
    `Summary.\n\n## Copilot off\n\n<!--\n## Claude review\n\n${BOTH}\n-->\n`,
  );
  assert.equal(door.declared, true);
  assert.equal(door.codeReview, false);
  assert.equal(door.checklist, false);
  assert.equal(door.opens, false);
});

test('a CRLF body still declares and records', () => {
  assert.equal(riskyDoor(off(BOTH).replace(/\n/g, '\r\n')).opens, true);
});

test('a placeholder word inside code is quoted material, not a placeholder', () => {
  const inline = claudeReviewState(
    body(
      'cavecrew-reviewer: 1 Low, fixed. The parser now maps `"n/a"` to empty.',
    ),
  );
  assert.equal(inline.recorded, true);
  const fenced = claudeReviewState(
    body(
      'cavecrew-reviewer: no findings.\n\n```ts\nconst label = "n/a";\n// TBD\n```',
    ),
  );
  assert.equal(fenced.recorded, true);
});

test('a placeholder outside code still blocks, even next to code', () => {
  const r = claudeReviewState(body('Reviewer: n/a. See `x.ts`.'));
  assert.equal(r.recorded, false);
});

test('a section that is only code holds no record', () => {
  const r = claudeReviewState(body('```\ncavecrew-reviewer: no findings\n```'));
  assert.equal(r.recorded, false);
});
