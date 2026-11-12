// Whether a session is correctly waiting on something that will wake it: a background command
// it started and has not yet heard finish, or a ScheduleWakeup still due. The autonomous guard
// lets such a session stop without spending a continuation, because the wake is already coming.
// Blocking it instead re-invoked the model every few seconds with nothing to do, and drained the
// continuation cap during a single CI wait (2026-11-12).
//
// Read from the session transcript (JSONL). Launches are recorded in tool results as "Command
// running in background with ID: <id>" (Bash); endings arrive as <task-notification> blocks
// naming <task-id> with a non-running <status>.
// A launch older than `maxAgeMs` is ignored, so a watcher that died without notifying cannot
// hold the guard open forever.

const LAUNCH = /running in background with ID: ([A-Za-z0-9_-]+)/g;
const ENDED =
  /<task-id>([A-Za-z0-9_-]+)<\/task-id>[\s\S]{0,600}?<status>(?!running)[a-z_]+<\/status>/g;

const textOf = (entry) => {
  const content = entry?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      if (typeof c?.text === 'string') return c.text;
      if (typeof c?.content === 'string') return c.content;
      if (Array.isArray(c?.content))
        return c.content.map((x) => x?.text ?? '').join('\n');
      return '';
    })
    .join('\n');
};

/**
 * @param {string} jsonl the session transcript
 * @param {number} now epoch ms
 * @param {number} maxAgeMs launches older than this are treated as dead
 * @returns {{ tasks: string[], wakeUntil: number | null }} what is still due to wake the session
 */
export function pendingWakes(jsonl, now, maxAgeMs = 6 * 60 * 60_000) {
  const launched = new Map(); // id -> launch time
  const ended = new Set();
  let wakeUntil = null;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a partial last line while the transcript is being written
    }
    const at = Date.parse(entry.timestamp ?? '') || now;
    const text = textOf(entry);
    for (const m of text.matchAll(LAUNCH)) launched.set(m[1], at);
    for (const m of text.matchAll(ENDED)) ended.add(m[1]);
    const content = entry?.message?.content;
    if (entry.type === 'assistant' && Array.isArray(content))
      for (const c of content) {
        if (c?.type !== 'tool_use' || c.name !== 'ScheduleWakeup') continue;
        if (c.input?.stop) wakeUntil = null;
        else if (Number(c.input?.delaySeconds) > 0)
          wakeUntil = at + Number(c.input.delaySeconds) * 1000;
      }
  }
  const tasks = [...launched]
    .filter(([id, at]) => !ended.has(id) && now - at <= maxAgeMs)
    .map(([id]) => id);
  return { tasks, wakeUntil: wakeUntil && wakeUntil > now ? wakeUntil : null };
}
