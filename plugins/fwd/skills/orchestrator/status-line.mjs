// Lane status-line parser. A convention, not enforced: nothing depends on it at runtime.
// A lane's message opens with `done: ...`, `blocked: ...` or `needs-decision: ...`.

const STATUS = /^(done|blocked|needs-decision)\s*:\s*(.*)$/i;

/** Parse the first line of a message. Returns { verb, text } or null (no verb). */
export function parseStatusLine(message) {
  if (typeof message !== 'string') return null;
  const first = message.trimStart().split(/\r?\n/, 1)[0];
  const m = STATUS.exec(first.trim());
  return m ? { verb: m[1].toLowerCase(), text: m[2].trim() } : null;
}
