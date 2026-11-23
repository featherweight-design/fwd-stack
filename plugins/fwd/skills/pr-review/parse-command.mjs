// Which gated actions a shell command takes, on which PRs, in which repositories.
//
// This used to be a chain of greps in gate-hook.sh, and they read only one spelling of each
// command. `gh pr merge 42 --squash` was gated; `gh pr merge --squash 42` and
// `gh pr merge https://github.com/o/r/pull/42` found no number, and the hook allowed what it
// could not read, so a flag placed first skipped the merge bar and the CI check entirely.
//
// Here the command is split into its simple commands the way a shell would (separators inside
// quotes do not count), each one is tokenised, and EVERY gated command in a chain is reported:
// stopping at the first let `gh pr merge feat/x; gh pr merge 42` through on the unreadable one.
//
//   node parse-command.mjs '<command>'   prints `<action> <pr> [<owner/name>]` per gated command
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

import { isMain } from '../../lib/is-main.mjs';

const REPO = '[A-Za-z0-9._-]+/[A-Za-z0-9._-]+';

// `gh pr merge` flags that take a value, so their value is never read as the PR.
const VALUE_FLAGS = new Set([
  '-t',
  '--subject',
  '-b',
  '--body',
  '-F',
  '--body-file',
  '-R',
  '--repo',
  '-A',
  '--author-email',
  '--match-head-commit',
]);

// The simple commands in a command line, each as its words with quotes removed. Separators
// (`&&`, `||`, `;`, `|`, `&`, newline) end a command only outside quotes. Good enough for reading
// arguments; it is not a shell.
export function simpleCommands(cmd) {
  const commands = [];
  const substitutions = [];
  let words = [];
  let word = null;
  let quote = null;
  // A redirection (`2>/dev/null`, `>out`, `<<'EOF'`) is not an argument: its operator, any file
  // descriptor before it and its target word are dropped, so `script.sh 2>/dev/null 42` reads 42.
  let dropNext = false;
  const endWord = () => {
    if (word !== null) {
      if (dropNext) dropNext = false;
      else words.push(word);
    }
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    // A backslash-newline is a line continuation, removed before anything else reads the line.
    if (ch === '\\' && cmd[i + 1] === '\n' && quote !== "'") {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else if (
        quote === '"' &&
        (ch === '`' || (ch === '$' && cmd[i + 1] === '('))
      ) {
        // Double quotes still run a command substitution: its contents are a command line of
        // their own, read as one, while the quoted text around it stays argument data.
        const end = substitutionEnd(cmd, i);
        const body = ch === '`' ? cmd.slice(i + 1, end) : cmd.slice(i + 2, end);
        substitutions.push(...simpleCommands(body));
        // Its output is unknown here, so the word keeps a `$`: `"4$(printf 2)"` must never read
        // as PR 4.
        word += '$';
        i = end;
      } else if (ch === '\\' && quote === '"' && i + 1 < cmd.length)
        word += cmd[++i];
      else word += ch;
      continue;
    }
    // An unquoted `#` starting a word is a comment to the end of the line. Read as text, an
    // apostrophe in it (`# don't`) opened a quote that swallowed the command after it.
    if (ch === '#' && word === null) {
      while (i + 1 < cmd.length && cmd[i + 1] !== '\n') i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      word ??= '';
    } else if (ch === '\\' && i + 1 < cmd.length) {
      word = (word ?? '') + cmd[++i];
    } else if (';\n|&()`'.includes(ch)) {
      // Command separators, and the grouping and substitution marks that start a new command:
      // `(…)`, `$(…)` and backticks run their contents as commands of their own.
      if ((ch === '&' || ch === '|') && cmd[i + 1] === ch) i++;
      if (ch === '(' && word === '$') word = null;
      endCommand();
    } else if (ch === '>' || ch === '<') {
      if (word !== null && /^\d+$/.test(word)) word = null; // the fd of `2>`
      endWord();
      while (cmd[i + 1] === '>' || cmd[i + 1] === '<' || cmd[i + 1] === '&')
        i++;
      // `>&2` names a descriptor, not a file: drop it like any other target.
      dropNext = true;
    } else if (/\s/.test(ch)) {
      endWord();
    } else {
      word = (word ?? '') + ch;
    }
  }
  endCommand();
  return [...commands, ...substitutions];
}

// Index of the character that closes the substitution opened at `start` (`$(` or a backtick),
// counting nested parentheses for `$(`. An unclosed one runs to the end.
function substitutionEnd(cmd, start) {
  if (cmd[start] === '`') {
    const end = cmd.indexOf('`', start + 1);
    return end === -1 ? cmd.length : end;
  }
  let depth = 0;
  for (let i = start + 1; i < cmd.length; i++) {
    if (cmd[i] === '(') depth++;
    else if (cmd[i] === ')' && --depth === 0) return i;
  }
  return cmd.length;
}

// The `NAME=value` words a command starts with: its environment. A `GH_REPO=` anywhere later is an
// argument (`--body GH_REPO=a/b`, a script's own parameter), not an assignment.
const leadingAssignments = (words) => {
  const out = [];
  for (const w of words) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) out.push(w);
    else break;
  }
  return out;
};
const ghRepoOf = (words) =>
  leadingAssignments(words)
    .map((w) => w.match(/^GH_REPO=(.*)$/)?.[1])
    .filter((v) => v !== undefined)
    .at(-1);

// A command's repository, most explicit first: an API path, then `-R`/`--repo`, then a
// `GH_REPO=` that only sets the default.
const repoIn = (words) => {
  // Only a word that IS an API path: `repos/a/b/pulls/7` quoted inside a --body value is text.
  for (const w of words) {
    const path = w.match(
      new RegExp(`^(?:https://api\\.github\\.com)?/?repos/(${REPO})/pulls/`),
    );
    if (path) return path[1];
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (
      (w === '-R' || w === '--repo') &&
      new RegExp(`^${REPO}$`).test(words[i + 1] ?? '')
    )
      return words[i + 1];
    // `--repo=o/r` and the attached short form `-Ro/r`.
    const eq = w.match(new RegExp(`^(?:--repo=|-R)(${REPO})$`));
    if (eq) return eq[1];
  }
  const env = ghRepoOf(words);
  return env && new RegExp(`^${REPO}$`).test(env) ? env : null;
};

// The PR a `gh … pr merge` names: a number (`42` or `#42`) or a pull URL, wherever it sits
// among the flags. A branch name, or nothing (the current branch), yields no PR.
// Flags `gh pr merge` takes with no value. With VALUE_FLAGS this is the whole allowlist: any other
// option (a cluster such as `-st 9`, a flag this table does not know) makes the merge unreadable
// rather than risking a value being read as the PR.
const BOOLEAN_FLAGS = new Set([
  '-s',
  '--squash',
  '-m',
  '--merge',
  '-r',
  '--rebase',
  '-d',
  '--delete-branch',
  '--auto',
  '--disable-auto',
  '--admin',
]);
const isRepoFlag = (w) =>
  w === '-R' || w === '--repo' || /^(?:--repo=|-R)\S/.test(w);

function mergeOf(words) {
  // By basename, so `/usr/local/bin/gh` is gh too.
  const gh = words.findIndex((w) => w.split('/').at(-1) === 'gh');
  if (gh === -1) return null;
  const repo = repoIn(words);
  const unreadable = { action: 'merge', pr: null, repo };
  // Only a repository flag may sit before `pr` or between `pr` and `merge`
  // (`gh -R o/r pr merge 42`, `gh pr --repo=o/r merge 42`).
  const skipRepoFlags = (i) => {
    while (i < words.length && isRepoFlag(words[i]))
      i += words[i] === '-R' || words[i] === '--repo' ? 2 : 1;
    return i;
  };
  // Every repository selector must be a plain owner/name: `--repo "$TARGET"` or `--repo
  // host/o/r` names a repository the gate cannot read, so the merge is unreadable.
  const selectors = words.flatMap((w, k) =>
    w === '-R' || w === '--repo'
      ? [words[k + 1] ?? '']
      : (w.match(/^(?:--repo=|-R)(.+)$/)?.slice(1) ?? []),
  );
  if (selectors.some((v) => !new RegExp(`^${REPO}$`).test(v)))
    return unreadable;
  let i = skipRepoFlags(gh + 1);
  if (words[i] !== 'pr') {
    // Something other than a repository flag before the subcommand: if this is a merge at all,
    // it is not one the gate can read.
    return words.slice(i).includes('merge') && words.slice(i).includes('pr')
      ? unreadable
      : null;
  }
  i = skipRepoFlags(i + 1);
  if (words[i] !== 'merge')
    return words.slice(i).includes('merge') ? unreadable : null;
  let pr = null;
  let prRepo = null;
  const flags = [];
  for (let j = i + 1; j < words.length; j++) {
    const a = words[j];
    if (VALUE_FLAGS.has(a)) {
      j++;
      continue;
    }
    // `--auto` and `--admin` change WHEN or HOW the merge happens, whatever value is attached.
    const named = a.match(/^--(auto|admin)(?:=|$)/);
    if (named && !flags.includes(named[1])) flags.push(named[1]);
    if (BOOLEAN_FLAGS.has(a) || isRepoFlag(a) || /^--[a-z-]+=/.test(a))
      continue;
    if (a.startsWith('-') || a.includes('$')) return unreadable;
    if (pr !== null) return unreadable; // a second positional: not a form gh takes
    const n = a.match(/^#?(\d+)$/);
    const url = a.match(
      new RegExp(`^https?://github\\.com/(${REPO})/pull/(\\d+)/?$`),
    );
    if (n) pr = n[1];
    else if (url) [pr, prRepo] = [url[2], url[1]];
    else return unreadable; // a branch name, or anything else
  }
  // `flags` appears only when there is one, so a plain merge reads exactly as it always did.
  return pr
    ? {
        action: 'merge',
        pr,
        repo: prRepo ?? repo,
        ...(flags.length ? { flags } : {}),
      }
    : unreadable;
}

// The GraphQL mutations that put a PR in a merge queue or switch on auto-merge. They name a PR by
// node id, so they cannot be attributed to a number; the hook only needs to know they are there.
// Counted on the text with quotes and backslashes removed, like the other mention checks.
export function queueMention(cmd) {
  const plain = cmd.replace(/\\\n/g, ' ').replace(/['"\\]/g, ' ');
  return /\b(?:enqueuePullRequest|enablePullRequestAutoMerge)\b/.test(plain);
}

// The away-mode flags in a command line: `auto`, `admin` from any readable merge, `queue` from a
// queue or auto-merge mutation. Unique, in first-seen order.
export function mergeFlags(cmd) {
  const flags = parseCommand(cmd).flatMap((g) => g.flags ?? []);
  if (queueMention(cmd)) flags.push('queue');
  return [...new Set(flags)];
}

function gatedIn(words) {
  const gated = gatedWords(words);
  // Any expansion left in a gated command (`$OWNER`, `"$TARGET_REPO"`, a substitution's `$`)
  // stands for a value the hook cannot see: the PR, the repository or both. The whole class is
  // unreadable, so it is denied rather than checked against a guess.
  if (gated && words.some((w) => w.includes('$')))
    return { ...gated, pr: null };
  return gated;
}

function gatedWords(words) {
  // A merge whose PR the parser cannot resolve is still reported, with pr null, so it is
  // counted as unreadable rather than dropped.
  const merge = mergeOf(words);
  if (merge) return merge;
  const text = words.join(' ');
  // The REST form of a merge (`gh api -X PUT repos/O/R/pulls/N/merge`) never spells
  // `gh pr merge`, and it is how orchestrated lanes merge.
  const rest = words
    .map((w) =>
      w.match(
        /^(?:https:\/\/api\.github\.com)?\/?repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/merge$/,
      ),
    )
    .find(Boolean);
  if (rest) return { action: 'merge', pr: rest[1], repo: repoIn(words) };
  // Two re-request shapes. The raw API call carries the PR in its path. A project wrapper hides
  // that call inside a script, so the hook only sees the script name and its arguments — one
  // project mandates `scripts/request-copilot-review.sh <pr>`.
  const pr =
    text.match(/pulls\/(\d+)\/requested_reviewers/)?.[1] ??
    text.match(/request-copilot-review\S*\s+#?(\d+)/)?.[1];
  if (pr) return { action: 'rerequest', pr, repo: repoIn(words) };
  return null;
}

// Every gated command in the line, each with the repository its own words name (a flag on one
// command never lends its repository to another).
// `bash -c '…'`, `sh -lc '…'`, `zsh -c '…'` and `eval '…'` run their argument as a command line,
// so it is parsed as one rather than read as a single quoted word. Only at the command's
// executable position, past assignments and transparent prefixes: `--subject eval` is a value.
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const PREFIXES = new Set([
  'env',
  'command',
  'exec',
  'nohup',
  'time',
  'sudo',
  'nice',
]);
function innerCommandLine(words) {
  let at = 0;
  while (
    at < words.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]) || PREFIXES.has(words[at]))
  )
    at++;
  const exe = words[at]?.split('/').at(-1);
  if (exe === 'eval') return words.slice(at + 1).join(' ');
  if (!SHELLS.has(exe)) return null;
  const flag = words.findIndex((w, i) => i > at && /^-[a-z]*c[a-z]*$/.test(w));
  return flag === -1 ? null : (words[flag + 1] ?? null);
}

// Every gated command in the line, each with the repository its own words name (a flag on one
// command never lends its repository to another). A `GH_REPO=` set on a shell wrapper is the
// default for the commands it runs, as it is in their environment.
export function parseCommand(cmd, depth = 0, inheritedRepo = null) {
  // `export GH_REPO=o/r; gh pr merge 42` sets the default in a command before the merge, which
  // this hook runs ahead of. A merge that names no repository of its own then cannot be read.
  const exported =
    depth === 0 &&
    simpleCommands(cmd).some(
      (words) =>
        // `export GH_REPO=…`, or a command that is nothing but assignments (`GH_REPO=…;`).
        (words[0] === 'export' &&
          words.some((w) => w.startsWith('GH_REPO='))) ||
        (words.length > 0 &&
          leadingAssignments(words).length === words.length &&
          words.some((w) => w.startsWith('GH_REPO='))),
    );
  return simpleCommands(cmd).flatMap((words) => {
    const inner = depth < 3 ? innerCommandLine(words) : null;
    if (inner !== null) {
      const raw = ghRepoOf(words);
      // A wrapper's GH_REPO that is not a plain owner/name (`github.com/o/r`) cannot be read.
      if (raw !== undefined && !new RegExp(`^${REPO}$`).test(raw))
        return parseCommand(inner, depth + 1, null).map((g) => ({
          ...g,
          pr: null,
        }));
      const env = raw;
      return parseCommand(inner, depth + 1, env ?? inheritedRepo);
    }
    const gated = gatedIn(words);
    if (!gated) return [];
    const repo = gated.repo ?? inheritedRepo;
    const own = ghRepoOf(words);
    if (own !== undefined && !new RegExp(`^${REPO}$`).test(own))
      return [{ ...gated, pr: null, repo: null }];
    const ownAssignment = own !== undefined;
    if (gated.action === 'merge' && !repo && exported && !ownAssignment)
      return [{ ...gated, pr: null, repo: null }];
    return [{ ...gated, repo }];
  });
}

// FAIL CLOSED. Shell is too rich to parse completely: heredocs, redirections, substitutions in
// every position, wrapper options. Three review rounds each found new forms, and every form the
// parser misread was a merge the hook ALLOWED. So instead of chasing them, the hook counts the
// merges the raw text mentions and the merges the parser could attribute to a PR; when the text
// mentions more, the command is unreadable and is denied with the form to use instead. A miss
// now costs a rewritten command, never an ungated merge. (A mention in a heredoc or a commit
// message is denied too; rephrase it.) This is not a security boundary, only a check that an
// agent cannot skip by accident.
export function unaccountedMerges(cmd) {
  // Counted on the text with quotes and line continuations removed, so `gh pr 'merge'` is a
  // mention too and a merge the parser did read cannot cancel one it did not.
  const plain = cmd.replace(/\\\n/g, ' ').replace(/['"\\]/g, ' ');
  const mentioned =
    (
      plain.match(
        /\bpr\s+(?:(?:-R|--repo)\s+\S+\s+|--repo=\S+\s+|-R\S+\s+)*merge\b/g,
      ) ?? []
    ).length + (plain.match(/pulls\/[^/\s]+\/merge\b/g) ?? []).length;
  const merges = parseCommand(cmd).filter((g) => g.action === 'merge');
  const unresolved = merges.filter((g) => !g.pr).length;
  const read = merges.length - unresolved;
  return Math.max(unresolved, mentioned - read);
}

// The blunt end of the fail-closed rule. Review kept finding new places an expansion could hide
// (a REST path, a GH_REPO value on a wrapper, a repeated assignment), each a value the hook
// cannot see. So a command line that mentions a gated action at all, and contains an expansion
// (`$`, a backtick) or sets GH_REPO more than once, is unreadable as a whole.
// The GraphQL `requestReviews` mutation names a PR by node id, never a number, so the gate can
// never attribute it: it is always unreadable, and the hook denies it.
export function mentionsGatedAction(cmd) {
  const plain = cmd.replace(/\\\n/g, ' ').replace(/['"\\]/g, ' ');
  return (
    /\bpr\s+(?:(?:-R|--repo)\s+\S+\s+|--repo=\S+\s+|-R\S+\s+)*merge\b/.test(
      plain,
    ) ||
    /pulls\/[^/\s]+\/merge\b/.test(plain) ||
    /requested_reviewers|request-copilot-review|requestReviews/.test(plain)
  );
}
export function unreadableLine(cmd) {
  const parsed = parseCommand(cmd);
  // Anything the tokenizer found but could not resolve is unreadable, whatever the raw text says.
  if (parsed.some((g) => !g.pr)) return true;
  if (!mentionsGatedAction(cmd)) return false;
  const plain = cmd.replace(/\\\n/g, ' ').replace(/['"\\]/g, ' ');
  const rerequestsMentioned = (
    plain.match(/requested_reviewers|request-copilot-review|requestReviews/g) ??
    []
  ).length;
  const rerequestsRead = parsed.filter((g) => g.action === 'rerequest').length;
  return (
    // An expansion or a backtick: a value the hook cannot see.
    /[$`]/.test(cmd) ||
    (cmd.match(/\bGH_REPO=/g) ?? []).length > 1 ||
    // GH_REPO set anywhere (through `env`, an `export`, a wrapper) while a gated command resolved
    // no repository of its own: the hook cannot know which repository that command acts on.
    (/\bGH_REPO\b/.test(cmd) && parsed.some((g) => !g.repo)) ||
    // More than one repository selector: gh takes the last, a reader could take the first.
    (parsed.length > 0 &&
      simpleCommands(cmd).some(
        (words) =>
          words.filter(
            (w) => w === '-R' || w === '--repo' || /^(?:--repo=|-R)\S/.test(w),
          ).length > 1,
      )) ||
    unaccountedMerges(cmd) > 0 ||
    rerequestsMentioned > rerequestsRead
  );
}

// The directory a command line's gated commands run in. The hook runs in the SESSION's working
// directory, and an agent often works from a parent folder that is not a checkout at all, with
// `cd <checkout> && <gated command>`. A gated command that names no repository of its own is then
// resolved where it really runs: the hook starts the gate in this directory, not the session's.
//
// Returns `{ dir: null }` when the line changes directory nowhere (the session's directory stands,
// as it always did), `{ dir }` when every gated command runs in one directory reached by plain
// `cd <path>` steps, and `{ unknown: true }` when that directory cannot be read. Unknown covers
// every change of directory this reader does not follow: `cd` with no path, `cd -`, an option or a
// redirection, `pushd`/`popd`, `source`/`.` (a sourced file can `cd`), a `cd` behind a prefix or a
// keyword (`command cd`, `then cd`), an `eval` that changes directory, any `||` on a line that
// changes directory (either branch may run), a `cd` sharing a subshell, pipeline or background job
// with a gated command, and gated commands in two directories. The hook then needs the repository
// named in the command itself, and denies the command otherwise. Reading less than a shell reads is
// the fail-closed direction: an unknown directory never lets through a command that the session's
// directory would have denied.
//
// A quick filter first: a line naming none of these words cannot change directory.
const CHANGES_DIR =
  /(^|[\s;&|(`'"{])(cd|pushd|popd|source|\.)(?=$|[\s;&|)`'"}])/;

// The elements of a command list: the text between `&&`, `||`, `;` and newlines outside quotes,
// parentheses and backticks. A `cd` in one element applies to the elements after it, because each
// of those runs in the same shell; a pipeline, subshell or background job stays inside its element.
export const listElements = (cmd) => listWithOperators(cmd).map((e) => e.text);

// The same elements, each with the operator that joined it to the one before: `''` for the first,
// `&&`, `||`, or `;` (a newline too).
export function listWithOperators(cmd) {
  const out = [];
  let start = 0;
  let op = '';
  let quote = null;
  let depth = 0;
  let tick = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\') {
      i++;
      continue;
    }
    // An unquoted `#` starting a word is a comment to the end of the line, as simpleCommands
    // reads it: a `;` or a quote inside it separates nothing.
    if (ch === '#' && (i === 0 || /[\s;&|()]/.test(cmd[i - 1]))) {
      while (i + 1 < cmd.length && cmd[i + 1] !== '\n') i++;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '`') tick = !tick;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && !tick) {
      const two = cmd.slice(i, i + 2);
      if (two === '&&' || two === '||' || ch === ';' || ch === '\n') {
        // A line break straight after `&&` or `||` continues the list; it is not a `;`.
        if (
          ch === '\n' &&
          (op === '&&' || op === '||') &&
          cmd.slice(start, i).trim() === ''
        ) {
          start = i + 1;
          continue;
        }
        out.push({ text: cmd.slice(start, i), op });
        op = two === '&&' || two === '||' ? two : ';';
        if (two === '&&' || two === '||') i++;
        start = i + 1;
      }
    }
  }
  out.push({ text: cmd.slice(start), op });
  return out
    .map((e) => ({ ...e, text: e.text.trim() }))
    .filter((e) => e.text !== '');
}

// The text outside quotes, for finding operators.
const unquoted = (cmd) => cmd.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""');

// Words a shell reads before the command itself: keywords and prefixes that run the next word in
// this same shell (`command cd /x` changes this shell's directory).
const LEADERS = new Set([
  ...PREFIXES,
  'builtin',
  'if',
  'then',
  'else',
  'elif',
  'do',
  'while',
  'until',
  '!',
  '{',
]);
const DIR_COMMANDS = new Set(['cd', 'pushd', 'popd', 'source', '.']);
// Whether one simple command may change the shell's directory: a directory command where the
// command goes, past assignments, keywords and prefixes, or `cd`, `pushd`, `popd` or `source` as a
// word anywhere in it (an option to a prefix, `env -i cd /x`, would otherwise hide it). `.` counts
// only where the command goes, so `git add .` stays inert.
function mayChangeDir(words) {
  let i = 0;
  while (
    i < words.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || LEADERS.has(words[i]))
  )
    i++;
  if (DIR_COMMANDS.has(words[i])) return true;
  return words.some((w) => DIR_COMMANDS.has(w) && w !== '.');
}

// `eval` runs its text in this shell, so a `cd` in it moves every command after it.
const isEval = (words) =>
  words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && !PREFIXES.has(w)) ===
  'eval';

// Whether a command line may change directory anywhere: the raw text, or any word once the shell
// has removed quotes and backslashes (`\cd`, `'cd'`), or a wrapper's body inside one word.
// A wrapper's body is read the same way, as the command line it is.
const changesDir = (text, depth = 0) =>
  CHANGES_DIR.test(text) ||
  simpleCommands(text).some((words) => {
    if (mayChangeDir(words) || words.some((w) => CHANGES_DIR.test(w)))
      return true;
    const body = depth < 3 ? innerCommandLine(words) : null;
    return body !== null && changesDir(body, depth + 1);
  });

export function workingDir(cmd, cwd, home = homedir()) {
  if (!changesDir(cmd)) return { dir: null };
  const where = walkDirs(cmd, cwd, home, 0);
  if (where.unknown) return where;
  return { dir: where.dir === cwd ? null : where.dir };
}

// Shell grammar this walker does not model: conditionals, loops, groups, functions, and the
// builtins that run text or a command in this same shell. On a line that changes directory, any of
// them as a word makes the directory unknown, rather than one more shape to chase
// (`builtin eval 'cd /b'`, `if …; then cd /b; fi`).
const UNMODELLED = new Set([
  'eval',
  'builtin',
  'command',
  'exec',
  'source',
  'if',
  'then',
  'elif',
  'else',
  'fi',
  'while',
  'until',
  'do',
  'done',
  'for',
  'case',
  'esac',
  'select',
  'function',
  'coproc',
  '{',
  '}',
  '!',
]);

function walkDirs(cmd, cwd, home, depth) {
  const unknown = { unknown: true };
  if (depth > 3) return unknown;
  if (
    simpleCommands(cmd).some(
      (words) => words.some((w) => UNMODELLED.has(w)) || words[0] === '.',
    )
  )
    return unknown;
  // `cd /a || cd /b; <gated>` runs in either directory, depending on the first `cd`.
  const branches = /\|\|/.test(unquoted(cmd));
  // A single `&` backgrounds the whole and-or list before it (`cd /b && make & <gated>`), so a
  // `cd` in it never reaches what follows. Redirections (`2>&1`, `&>`) are not backgrounding.
  if (/(^|[^&>])&(?![&>])/.test(unquoted(cmd))) return unknown;
  let dir = cwd;
  let gatedDir = null;
  const ranIn = (d) => {
    if (gatedDir !== null && gatedDir !== d) return false;
    gatedDir = d;
    return true;
  };
  // `make && cd /b; <gated>`: the cd runs only if `make` succeeded, and the gated command runs
  // either way, so after the `&&` chain holding such a cd ends, the directory is unknown. Inside
  // the chain it is not: `make && cd /b && <gated>` runs only where the cd took it.
  let conditionalCd = false;
  let unsure = false;
  for (const { text: element, op } of listWithOperators(cmd)) {
    if (op !== '&&' && conditionalCd) {
      unsure = true;
      conditionalCd = false;
    }
    const commands = simpleCommands(element);
    const gated = parseCommand(element).length > 0;
    const words = commands.length === 1 ? commands[0] : null;
    // `cd <path>` alone: no option, no redirection, no other command in its element.
    const plain =
      words?.[0] === 'cd' && words.length === 2 && !/[|&()`<>]/.test(element);
    if (plain) {
      const to = words[1];
      if (branches || to === '' || to.startsWith('-') || /[\n$]/.test(to))
        return unknown;
      const path =
        to === '~' ? home : to.startsWith('~/') ? home + to.slice(1) : to;
      // A relative `cd` with no session directory to start from cannot be resolved.
      if (!isAbsolute(path) && !dir) return unknown;
      dir = resolve(dir ?? '/', path);
      if (op === '&&') conditionalCd = true;
      // A cd that always runs, to an absolute path, settles the directory again.
      else if (isAbsolute(path)) unsure = false;
      continue;
    }
    // A shell wrapper (`bash -c 'cd x && …'`): its `cd` ends with it, and its gated commands run
    // where it changed to. `eval` is not a wrapper for this: it runs in this shell.
    // A wrapper that changes directory, sharing its element with anything (`bash -c 'cd x && …' |
    // cat`), is not followed.
    const movingWrappers = commands.filter((c) => {
      const body = innerCommandLine(c);
      return body !== null && changesDir(body);
    });
    if (movingWrappers.length > 0 && commands.length !== 1) return unknown;
    const inner = words ? innerCommandLine(words) : null;
    if (inner !== null && changesDir(inner)) {
      if (isEval(words)) return unknown;
      const sub = walkDirs(inner, dir, home, depth + 1);
      if (sub.unknown) return unknown;
      if (sub.dir !== null && (unsure || !ranIn(sub.dir))) return unknown;
      continue;
    }
    if (commands.some(mayChangeDir)) {
      // A subshell's own `cd`, with nothing gated beside it, ends with the subshell.
      if (!gated && element.startsWith('(')) continue;
      return unknown;
    }
    if (gated && (unsure || !ranIn(dir))) return unknown;
  }
  return { dir: gatedDir };
}

if (isMain(import.meta.url)) {
  const cmd = process.argv[2] ?? '';
  const parsed = parseCommand(cmd);
  if (unreadableLine(cmd)) console.log('unreadable');
  // Only a line with something gated needs its directory. `cd <dir>` or `cd?` comes first; the
  // hook reads it apart from the `<action> <pr> [<owner/name>]` lines.
  if (parsed.length > 0) {
    const where = workingDir(cmd, process.argv[3] || null);
    if (where.unknown) console.log('cd?');
    else if (where.dir) console.log(`cd ${where.dir}`);
  }
  for (const g of parsed)
    if (g.pr) console.log([g.action, g.pr, g.repo].filter(Boolean).join(' '));
  // `flags <csv>`: what the away-window rule needs, read apart from the lines above.
  const flags = mergeFlags(cmd);
  if (flags.length) console.log(`flags ${flags.join(',')}`);
}
