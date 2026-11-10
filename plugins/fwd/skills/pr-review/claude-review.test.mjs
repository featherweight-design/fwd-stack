// node --test claude-review.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  claudeReviewState,
  copilotOffBar,
  copilotOffDoor,
  COPILOT_OFF_HINT,
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
  'Reviewer: `/code-review` medium, run before Copilot. 0 findings.',
  'None.',
  'No findings.',
  // A finding about a pending state is a record, not a placeholder.
  'cavecrew-reviewer: 1 Medium, the pending badge never clears. Fixed.',
  // Prose whose clause ENDS on a placeholder word describes the code, not the review.
  '/code-review medium: 1 Medium, the cleanup cancels a frame that is still pending. Fixed.',
  'cavecrew-reviewer: 1 Low, the retry stays queued while the upload is pending. Fixed.',
  'cavecrew-reviewer: 1 Medium, the export button showed while the label was TBD. Fixed.',
  'cavecrew-reviewer: 1 Low, an empty country field rendered as n/a. Fixed.',
  'cavecrew-reviewer: 1 Low, the sweep skipped items that are still to do. Fixed.',
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
  assert.deepEqual(copilotOffDoor(off(BOTH)), {
    declared: true,
    codeReview: true,
    checklist: true,
    opens: true,
    missing: [],
  });
});

test('"Checklist pass: no findings." counts as a record', () => {
  assert.equal(
    copilotOffDoor(
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
      copilotOffDoor(off(`/code-review medium: no findings.\n${line}`)).opens,
      true,
    );
  });
}

test('both passes without the heading do not open the door', () => {
  const door = copilotOffDoor(`Summary.\n\n## Claude review\n\n${BOTH}\n`);
  assert.equal(door.declared, false);
  assert.equal(door.opens, false);
  assert.deepEqual(door.missing, ['the `## Copilot off` heading']);
});

test('the heading without the checklist pass does not open the door', () => {
  const door = copilotOffDoor(off('/code-review medium: no findings.'));
  assert.equal(door.declared, true);
  assert.equal(door.codeReview, true);
  assert.equal(door.checklist, false);
  assert.equal(door.opens, false);
  assert.deepEqual(door.missing, [
    'a `Checklist pass:` line in `## Claude review`',
  ]);
});

test('the heading without /code-review does not open the door', () => {
  const door = copilotOffDoor(off('Checklist pass: no findings.'));
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
]) {
  test(`a placeholder checklist line is not a record: ${JSON.stringify(placeholder)}`, () => {
    const door = copilotOffDoor(
      off(`/code-review medium: no findings.\n${placeholder}`),
    );
    assert.equal(door.checklist, false);
    assert.equal(door.opens, false);
  });
}

test('a placeholder review section keeps the door shut even with both names in it', () => {
  const door = copilotOffDoor(
    off('/code-review medium: pending\nChecklist pass: no findings.'),
  );
  assert.equal(door.opens, false);
  assert.ok(door.missing.includes('a real `## Claude review` record'));
});

test('a checklist line in a later section cannot stand in for the review', () => {
  const door = copilotOffDoor(
    off(
      '/code-review medium: no findings.',
      '\n## Notes\n\nChecklist pass: no findings.\n',
    ),
  );
  assert.equal(door.checklist, false);
  assert.equal(door.opens, false);
});

test('a checklist line inside an HTML comment does not count', () => {
  const door = copilotOffDoor(
    off(
      '/code-review medium: no findings.\n<!-- Checklist pass: no findings. -->',
    ),
  );
  assert.equal(door.checklist, false);
});

test('a "## Copilot off" heading must be the whole heading', () => {
  assert.equal(
    copilotOffDoor(
      `Summary.\n\n## Copilot off until Friday\n\n## Claude review\n\n${BOTH}\n`,
    ).declared,
    false,
  );
});

test('an empty body declares nothing', () => {
  assert.deepEqual(copilotOffDoor(undefined), {
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

test('the Copilot-off hint names both passes', () => {
  assert.match(COPILOT_OFF_HINT, /\/code-review medium/);
  assert.match(COPILOT_OFF_HINT, /Checklist pass: no findings\./);
});

test('the unfilled hint is not a checklist record', () => {
  const door = copilotOffDoor(
    off(
      '/code-review medium: no findings.\nChecklist pass: <n> findings (C/H/M/L), <what was fixed>',
    ),
  );
  assert.equal(door.checklist, false);
  assert.equal(door.opens, false);
});

test('a "## Copilot off" heading inside an HTML comment is not a declaration', () => {
  const door = copilotOffDoor(
    `Summary.\n\n<!--\n## Copilot off\n-->\n\n## Claude review\n\n${BOTH}\n`,
  );
  assert.equal(door.declared, false);
  assert.equal(door.opens, false);
});

test('a commented-out Claude review section records nothing', () => {
  const door = copilotOffDoor(
    `Summary.\n\n## Copilot off\n\n<!--\n## Claude review\n\n${BOTH}\n-->\n`,
  );
  assert.equal(door.declared, true);
  assert.equal(door.codeReview, false);
  assert.equal(door.checklist, false);
  assert.equal(door.opens, false);
});

test('a CRLF body still declares and records', () => {
  assert.equal(copilotOffDoor(off(BOTH).replace(/\n/g, '\r\n')).opens, true);
});

// The gate's bar for the door: pr-gate.mjs reads copilotOffBar before the budget stop and before
// counting Copilot rounds, so neither can stand in for a shut door.
test('on a risky PR with the heading, the door alone decides the bar', () => {
  assert.equal(copilotOffBar(copilotOffDoor(off(BOTH)), true), true);
  assert.equal(
    copilotOffBar(
      copilotOffDoor(off('/code-review medium: no findings.')),
      true,
    ),
    false,
  );
});

test('the door does not apply without the heading or on a non-risky PR', () => {
  assert.equal(
    copilotOffBar(
      copilotOffDoor(`Summary.\n\n## Claude review\n\n${BOTH}\n`),
      true,
    ),
    null,
  );
  assert.equal(copilotOffBar(copilotOffDoor(off(BOTH)), false), null);
});
