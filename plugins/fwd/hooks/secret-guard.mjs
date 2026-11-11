// What the secret-print guard decides about one Bash command. Pure, so the rule is testable
// without a hook payload; secret-print-guard.mjs feeds it the command from the PreToolUse event.
//
// A command's output lands in the session transcript, so a command that prints a secret leaks it
// there. This denies the common ways an agent prints one by accident:
//
//   - dumping the environment: `env` or `printenv`, `export -p`, a bare `set`, `declare -x`;
//   - reading a `.env` file (`.env`, `.env.local`, `.envrc`, ...) with a pager or text tool;
//     templates (`.env.example`, `.env.sample`, `.env.template`) are fine;
//   - listing process command lines, which can carry secrets: `pgrep -f/-a/-l`, and `ps` unless
//     its columns are limited with `-o` to fields that are not the command line;
//   - inline code (`node -e`, `python -c`, `bun -e`, `deno eval`, `ruby -e`, `perl -e`, or a
//     heredoc fed to one) that touches the environment, unless every touch only tests presence:
//     `Boolean(process.env.X)`, `!!process.env.X`, `'X' in process.env`, `bool(os.getenv('X'))`;
//   - reading `/proc/<pid>/environ` or `/proc/<pid>/cmdline`;
//   - a recursive `grep -r` (or `rg --hidden`/`-uu`) over a folder that holds a `.env` file,
//     unless `--exclude`/`--include` (or an `rg -g` glob) keeps .env files out;
//   - `echo`/`printf` of a variable whose name marks it secret (`$API_KEY`, `$DATABASE_URL`,
//     `$GH_TOKEN`) when the output reaches the terminal; piping it into another program or
//     redirecting it to a file is fine.
//
// The command is parsed the way a shell splits it: pipes, `&&`, `||`, `;`, `&`, newlines,
// subshells, `$(...)`, backticks and process substitution all yield separate commands, and each is
// judged after peeling off leading assignments and wrappers (sudo, env, exec, command, nohup,
// nice, time, timeout, stdbuf, watch, xargs). `bash -c`/`sh -c`/`eval` strings and shell heredocs
// are parsed again. Quoted text is data, so a commit message or an `echo` that merely mentions
// `env` is not a match. Anything the parser cannot follow (variables, `find -exec`, remote
// commands) passes: this is a guard against accidents, not a sandbox.

const SAFE_DUMP =
  "Check one key's presence instead: node -e 'console.log(Boolean(process.env.KEY))'.";
const SAFE_FILE =
  "To see which env files exist, run ls -la .env*; to check a key is set, print only presence, e.g. grep -c '^KEY=' .env.";
const SAFE_PROC =
  'Find a process with pgrep -x <name>, or list processes with ps -o pid=,comm=; check one is alive with kill -0 <pid>.';

// ---------------------------------------------------------------------------------------------
// Parsing

const isSpace = (c) => c === ' ' || c === '\t';

class Parser {
  constructor(src) {
    this.src = src;
    this.i = 0;
    this.segments = []; // every simple command found, at any nesting depth
  }

  // Reads commands until the end of input, or until an unmatched `)` when `inParen` is set.
  sequence(inParen) {
    const s = this.src;
    let seg = this.newSegment();
    let word = null; // { text, quoted }
    let redirect = null; // pending redirect operator awaiting its target word
    let pendingHeredocs = [];
    let depth = 0;

    const endWord = () => {
      if (word === null) return;
      if (redirect) {
        if (redirect === '<<' || redirect === '<<-')
          pendingHeredocs.push({
            seg,
            delim: word.text,
            strip: redirect === '<<-',
          });
        else seg.redirects.push({ op: redirect, target: word.text });
        redirect = null;
      } else seg.words.push(word.text);
      word = null;
    };
    const endSegment = () => {
      endWord();
      redirect = null;
      seg = this.newSegment();
    };
    const append = (text, quoted = false) => {
      if (word === null) word = { text: '', quoted: false };
      word.text += text;
      if (quoted) word.quoted = true;
    };

    while (this.i < s.length) {
      const c = s[this.i];
      if (isSpace(c)) {
        endWord();
        this.i++;
      } else if (c === '\n') {
        endSegment();
        this.i++;
        for (const h of pendingHeredocs)
          h.seg.heredocs.push(this.heredocBody(h));
        pendingHeredocs = [];
      } else if (c === '#' && word === null) {
        while (this.i < s.length && s[this.i] !== '\n') this.i++;
      } else if (c === '\\') {
        if (s[this.i + 1] === '\n') this.i += 2;
        else {
          append(s[this.i + 1] ?? '', true);
          this.i += 2;
        }
      } else if (c === "'") {
        const end = s.indexOf("'", this.i + 1);
        const stop = end === -1 ? s.length : end;
        append(s.slice(this.i + 1, stop), true);
        this.i = stop + 1;
      } else if (c === '"') {
        this.i++;
        append(this.doubleQuoted(), true);
      } else if (c === '`') {
        this.i++;
        append(this.backtick());
      } else if (c === '$') {
        append(this.dollar(false));
      } else if (c === ';' || c === '|') {
        const piped = c === '|' && s[this.i + 1] !== '|' ? seg : null;
        endSegment();
        if (piped) piped.pipeTo = seg;
        this.i++;
        while (s[this.i] === ';' || s[this.i] === '|' || s[this.i] === '&')
          this.i++;
      } else if (c === '&') {
        if (s[this.i + 1] === '>') {
          endWord();
          this.i += s[this.i + 2] === '>' ? 3 : 2;
          redirect = '>';
        } else {
          endSegment();
          this.i++;
          if (s[this.i] === '&') this.i++;
        }
      } else if ((c === '<' || c === '>') && s[this.i + 1] === '(') {
        // Process substitution: its command runs, so parse it.
        endWord();
        this.i += 2;
        this.sequence(true);
        this.seg = seg;
        append(c === '<' ? '/dev/fd/63' : '/dev/fd/62');
      } else if (c === '<' || c === '>') {
        // A bare number right before the operator is a file descriptor, not an argument.
        if (word && !word.quoted && /^\d+$/.test(word.text)) word = null;
        endWord();
        let op = c;
        this.i++;
        if (c === '<' && s.startsWith('<<', this.i)) {
          op = '<<<';
          this.i += 2;
        } else if (c === '<' && s[this.i] === '<') {
          op = '<<';
          this.i++;
          if (s[this.i] === '-') {
            op = '<<-';
            this.i++;
          }
        } else if (s[this.i] === '>' || s[this.i] === '|') this.i++;
        else if (s[this.i] === '&') {
          // `>&2` or `<&0`: duplicate a descriptor, no file involved.
          this.i++;
          while (this.i < s.length && /[\d-]/.test(s[this.i])) this.i++;
          continue;
        }
        redirect = op === '<<<' ? '<<<' : op;
      } else if (c === '(') {
        depth++;
        endSegment();
        this.i++;
      } else if (c === ')') {
        if (depth === 0 && inParen) {
          this.i++;
          break;
        }
        if (depth > 0) depth--;
        endSegment();
        this.i++;
      } else {
        append(c);
        this.i++;
      }
    }
    endWord();
    for (const h of pendingHeredocs) h.seg.heredocs.push('');
  }

  newSegment() {
    // `expands`: names of variables the shell expands in this command (not single-quoted).
    const seg = {
      words: [],
      redirects: [],
      heredocs: [],
      expands: [],
      pipeTo: null,
    };
    this.segments.push(seg);
    this.seg = seg;
    return seg;
  }

  heredocBody({ delim, strip }) {
    const s = this.src;
    const lines = [];
    while (this.i < s.length) {
      let end = s.indexOf('\n', this.i);
      if (end === -1) end = s.length;
      const line = s.slice(this.i, end);
      this.i = end + 1;
      if ((strip ? line.replace(/^\t+/, '') : line) === delim) break;
      lines.push(line);
    }
    return lines.join('\n');
  }

  // After the opening quote; returns the text and leaves the cursor past the closing quote.
  doubleQuoted() {
    const s = this.src;
    let out = '';
    while (this.i < s.length && s[this.i] !== '"') {
      const c = s[this.i];
      if (c === '\\' && '"\\$`\n'.includes(s[this.i + 1] ?? '')) {
        if (s[this.i + 1] !== '\n') out += s[this.i + 1];
        this.i += 2;
      } else if (c === '`') {
        this.i++;
        out += this.backtick();
      } else if (c === '$') out += this.dollar(true);
      else {
        out += c;
        this.i++;
      }
    }
    this.i++;
    return out;
  }

  // After the opening backtick: parses the inner command and returns a placeholder.
  backtick() {
    const s = this.src;
    let inner = '';
    while (this.i < s.length && s[this.i] !== '`') {
      if (s[this.i] === '\\' && this.i + 1 < s.length) {
        inner += s[this.i + 1];
        this.i += 2;
      } else inner += s[this.i++];
    }
    this.i++;
    this.parseNested(inner);
    return '$(...)';
  }

  // At a `$`: command substitution, arithmetic, `${...}`, `$'...'`, or a plain `$`.
  dollar(inDouble) {
    const s = this.src;
    if (s.startsWith('$((', this.i)) {
      let depth = 0;
      const start = this.i;
      this.i++;
      while (this.i < s.length) {
        if (s[this.i] === '(') depth++;
        else if (s[this.i] === ')' && --depth === 0) {
          this.i++;
          break;
        }
        this.i++;
      }
      return s.slice(start, this.i);
    }
    if (s[this.i + 1] === '(') {
      const outer = this.seg;
      this.i += 2;
      this.sequence(true);
      this.seg = outer;
      return '$(...)';
    }
    if (s[this.i + 1] === '{') {
      const end = s.indexOf('}', this.i);
      const stop = end === -1 ? s.length : end + 1;
      const text = s.slice(this.i, stop);
      this.i = stop;
      // `${#X}` is a length and `${X:+set}` a presence test; neither prints the value.
      const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(:?\+)?/.exec(text);
      if (m && !m[2]) this.seg.expands.push(m[1]);
      return text;
    }
    if (!inDouble && s[this.i + 1] === "'") {
      this.i += 2;
      let out = '';
      while (this.i < s.length && s[this.i] !== "'") {
        if (s[this.i] === '\\' && this.i + 1 < s.length) {
          out += s[this.i + 1];
          this.i += 2;
        } else out += s[this.i++];
      }
      this.i++;
      return out;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(this.i + 1))?.[0];
    if (name) {
      this.seg.expands.push(name);
      this.i += 1 + name.length;
      return '$' + name;
    }
    this.i++;
    return '$';
  }

  parseNested(src) {
    const p = new Parser(src);
    p.sequence(false);
    this.segments.push(...p.segments);
  }
}

export function parseCommands(command) {
  const p = new Parser(String(command));
  p.sequence(false);
  return p.segments.filter((g) => g.words.length || g.redirects.length);
}

// ---------------------------------------------------------------------------------------------
// Shared helpers

export const basename = (w) => w.slice(w.lastIndexOf('/') + 1);
const isAssignment = (w) => /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(w);
export const isOption = (w) => w.length > 1 && w.startsWith('-');

const TEMPLATE_SUFFIX = /\.(example|sample|template|dist)$/;
// A .env-style file: basename starts with `.env` (`.env`, `.env.local`, `.envrc`, `.env*`).
export function isSecretEnvFile(path) {
  // Case-folded: macOS file systems treat `.Env` and `.env` as the same file.
  const b = basename(path).toLowerCase();
  return b.startsWith('.env') && !TEMPLATE_SUFFIX.test(b);
}
const PROC_SECRET = /^\/proc\/[^/]+\/(environ|cmdline)$/;

// Walks a command's arguments. `valueOpts` are short letters (or long names) whose value is the
// next word unless attached. Returns positionals and the option values seen.
function scanArgs(args, valueOpts = '', longValueOpts = []) {
  const positionals = [];
  const values = []; // { opt, value }
  const flags = []; // short letters and long names seen
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') {
      positionals.push(...args.slice(k + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      flags.push(name);
      if (eq !== -1) values.push({ opt: name, value: a.slice(eq + 1) });
      else if (longValueOpts.includes(name) && k + 1 < args.length)
        values.push({ opt: name, value: args[++k] });
    } else if (isOption(a)) {
      for (let j = 1; j < a.length; j++) {
        const letter = a[j];
        flags.push(letter);
        if (valueOpts.includes(letter)) {
          const rest = a.slice(j + 1);
          if (rest) values.push({ opt: letter, value: rest });
          else if (k + 1 < args.length)
            values.push({ opt: letter, value: args[++k] });
          break;
        }
      }
    } else positionals.push(a);
  }
  return { positionals, values, flags };
}

// ---------------------------------------------------------------------------------------------
// Wrappers: commands that run another command given as their arguments.

// Value-taking options per wrapper, so the wrapped command is found after them.
const WRAPPERS = {
  sudo: { value: 'ugpChDrtUT' },
  doas: { value: 'uC' },
  nohup: { value: '' },
  builtin: { value: '' },
  exec: { value: 'a' },
  nice: { value: 'n' },
  stdbuf: { value: 'ioe' },
  xargs: {
    // GNU -i, -l and -e take only an attached value, so they are plain flags here.
    value: 'InPLEdsa',
    long: [
      'max-args',
      'max-procs',
      'max-lines',
      'delimiter',
      'eof',
      'arg-file',
      'replace',
    ],
  },
};
const KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'do',
  'while',
  'until',
  '!',
  '{',
  '}',
  'time',
]);

// Splits the leading wrappers off a command. Returns { words } for the command that actually
// runs, { envDump: true } for `env` with no command, { skip: true } for a lookup like
// `command -v`, or { nested: string } for `env -S` and `watch`.
export function unwrap(words) {
  let w = words.slice();
  for (;;) {
    while (w.length && (isAssignment(w[0]) || KEYWORDS.has(w[0]))) {
      // `time -p cmd`
      if (w[0] === 'time' && w[1] === '-p') w.shift();
      w.shift();
    }
    if (!w.length) return { words: w };
    const name = basename(w[0]);
    if (name === 'command') {
      const rest = w.slice(1);
      let k = 0;
      while (k < rest.length && isOption(rest[k])) {
        if (/[vV]/.test(rest[k])) return { skip: true };
        k++;
      }
      w = rest.slice(k);
      continue;
    }
    if (name === 'env') {
      let k = 1;
      while (k < w.length) {
        const a = w[k];
        if (a === '--') {
          k++;
          break;
        }
        if (isAssignment(a)) {
          k++;
          continue;
        }
        if (/^-[a-zA-Z]*S$/.test(a) || a === '--split-string')
          return { nested: w.slice(k + 1).join(' ') };
        if (a.startsWith('--split-string=') || /^-[a-zA-Z]*S./.test(a))
          return { nested: a.replace(/^--split-string=|^-[a-zA-Z]*S/, '') };
        if (
          /^-[a-zA-Z0-9]*[uCP]$/.test(a) ||
          a === '--unset' ||
          a === '--chdir'
        )
          k += 2;
        else if (isOption(a) || a === '-') k++;
        else break;
      }
      if (k >= w.length) return { envDump: true };
      w = w.slice(k);
      continue;
    }
    if (name === 'timeout') {
      // Options, then the duration, then the command verbatim (its own flags included).
      let k = 1;
      while (k < w.length && isOption(w[k])) {
        const a = w[k];
        k +=
          /^-[a-zA-Z]*[sk]$/.test(a) || a === '--signal' || a === '--kill-after'
            ? 2
            : 1;
        if (a === '--') break;
      }
      w = w.slice(k + 1);
      continue;
    }
    if (name === 'watch') {
      // watch hands its arguments to `sh -c`, so a quoted command is one word: judge it as a
      // command line.
      let k = 1;
      while (k < w.length && isOption(w[k])) {
        const a = w[k];
        k += /^-[a-zA-Z]*[nqd]$/.test(a) || a === '--interval' ? 2 : 1;
        if (a === '--') break;
      }
      return { nested: w.slice(k).join(' ') };
    }
    const spec = WRAPPERS[name];
    if (!spec) return { words: w };
    const rest = w.slice(1);
    let k = 0;
    while (k < rest.length && isOption(rest[k])) {
      const a = rest[k];
      if (a === '--') {
        k++;
        break;
      }
      if (a.startsWith('--')) {
        const n = a.slice(2);
        k += spec.long?.includes(n) ? 2 : 1;
        continue;
      }
      // nice -5: a niceness, not a flag cluster
      if (name === 'nice' && /^-\d+$/.test(a)) {
        k++;
        continue;
      }
      let consumed = 1;
      for (let j = 1; j < a.length; j++) {
        if (spec.value.includes(a[j])) {
          if (j === a.length - 1) consumed = 2;
          break;
        }
      }
      k += consumed;
    }
    w = rest.slice(k);
  }
}

// ---------------------------------------------------------------------------------------------
// Rules

export const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);

// Text tools that print a file's contents (or most of it).
const READERS = new Set([
  'cat',
  'tac',
  'nl',
  'head',
  'tail',
  'less',
  'more',
  'most',
  'bat',
  'batcat',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'ack',
  'sed',
  'awk',
  'gawk',
  'mawk',
  'nawk',
  'strings',
  'xxd',
  'od',
  'hexdump',
  'sort',
  'uniq',
  'diff',
  'paste',
  'column',
  'tr',
  'cut',
  'base64',
  'basenc',
  'fold',
  'rev',
  'pr',
  'expand',
  'unexpand',
  'fmt',
  'iconv',
  'jq',
  'yq',
]);
// Readers whose first positional argument is a pattern or program, not a file.
const PATTERN_FIRST = {
  grep: {
    value: 'efABCmdD',
    patternOpts: 'ef',
    long: ['regexp', 'file'],
    valueLong: ['exclude', 'include', 'exclude-dir'],
  },
  egrep: {
    value: 'efABCmdD',
    patternOpts: 'ef',
    long: ['regexp', 'file'],
    valueLong: ['exclude', 'include', 'exclude-dir'],
  },
  fgrep: {
    value: 'efABCmdD',
    patternOpts: 'ef',
    long: ['regexp', 'file'],
    valueLong: ['exclude', 'include', 'exclude-dir'],
  },
  rg: {
    value: 'efABCmgtTMj',
    patternOpts: 'ef',
    long: ['regexp', 'file'],
    globOpts: ['g', 'glob', 'iglob'],
  },
  ag: { value: 'ABCmGg', patternOpts: '', long: [] },
  ack: { value: 'ABCm', patternOpts: '', long: [] },
  sed: { value: 'ef', patternOpts: 'ef', long: ['expression', 'file'] },
  awk: { value: 'fvF', patternOpts: 'f', long: ['file'] },
  gawk: { value: 'fvF', patternOpts: 'f', long: ['file'] },
  mawk: { value: 'fvF', patternOpts: 'f', long: ['file'] },
  nawk: { value: 'fvF', patternOpts: 'f', long: ['file'] },
  tr: { value: '', patternOpts: '', long: [], allPatterns: true },
  jq: { value: 'f', patternOpts: 'f', long: ['from-file'] },
  yq: { value: '', patternOpts: '', long: [] },
};
const READER_VALUES = {
  head: 'nc',
  tail: 'ncsF',
  xxd: 'cglos',
  od: 'AjNtw',
  sort: 'tkoST',
  cut: 'bcdf',
  fold: 'w',
  iconv: 'ft',
};
const ROOTISH = new Set([
  '',
  '.',
  './',
  '..',
  '../',
  '~',
  '~/',
  '/',
  '*',
  '.*',
]);

// Set by secretDecision for one call: (dir) => true | false | null, whether a folder holds a .env
// file (null when it cannot tell). Without one, the guard assumes a root-like or absolute path,
// or one built from a variable, holds one, and a relative subfolder does not.
let envProbe = null;
function holdsEnvFile(root) {
  const known = envProbe?.(root);
  if (known === true || known === false) return known;
  return ROOTISH.has(root) || root.startsWith('/') || root.includes('$');
}

function readerRule(name, args, redirects) {
  const sources = redirects.filter((r) => r.op === '<').map((r) => r.target);
  if (sources.some((t) => PROC_SECRET.test(t)))
    return `reading a process's environment or command line prints its secrets. ${SAFE_PROC}`;
  if (!READERS.has(name)) {
    if (sources.some(isSecretEnvFile))
      return `feeding a .env file into a command can print its values. ${SAFE_FILE}`;
    return null;
  }
  // `sed -i` rewrites the file in place and prints nothing.
  if (name === 'sed' && args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a)))
    return null;
  const pf = PATTERN_FIRST[name];
  const { positionals, values, flags } = scanArgs(
    args,
    pf ? pf.value : (READER_VALUES[name] ?? ''),
    pf ? [...pf.long, ...(pf.globOpts ?? []), ...(pf.valueLong ?? [])] : [],
  );
  // grep -c / -l / -q report counts, names or an exit code, never the matching lines.
  const QUIET = [
    'c',
    'l',
    'L',
    'q',
    'count',
    'quiet',
    'silent',
    'files-with-matches',
    'files-without-match',
  ];
  if (
    pf?.patternOpts.includes('e') &&
    name !== 'sed' &&
    flags.some((f) => QUIET.includes(f))
  )
    return null;
  let files = positionals;
  const afterPattern = () =>
    flags.some(
      (f) =>
        (f.length === 1 && pf.patternOpts.includes(f)) || pf.long.includes(f),
    )
      ? positionals
      : positionals.slice(1);
  // A recursive search from a project root also reads the .env files in it: grep -r does not
  // skip hidden files, and rg does with --hidden or -uu.
  const recursive =
    ['grep', 'egrep', 'fgrep'].includes(name) &&
    flags.some((f) =>
      ['r', 'R', 'recursive', 'dereference-recursive'].includes(f),
    );
  const hiddenRg =
    name === 'rg' &&
    (flags.includes('hidden') ||
      args.some((a) => /^-[a-zA-Z]*u[a-zA-Z]*u/.test(a)) ||
      flags.includes('.'));
  if (recursive || hiddenRg) {
    const globs = values.filter(
      (v) => v.opt === 'include' || pf.globOpts?.includes(v.opt),
    );
    // An include filter (or a positive rg glob) that no .env file matches keeps them all out.
    const positive = globs.filter((v) => !v.value.startsWith('!'));
    const excluded =
      values.some(
        (v) =>
          (v.opt === 'exclude' && v.value.toLowerCase().startsWith('.env')) ||
          (pf.globOpts?.includes(v.opt) && /^!.*\.env/i.test(v.value)),
      ) ||
      (positive.length > 0 &&
        !positive.some((v) => v.value.toLowerCase().includes('.env')));
    const roots = afterPattern();
    if (!excluded && (roots.length ? roots : ['.']).some(holdsEnvFile))
      return `a recursive \`${name}\` from the project root also searches .env files and prints matching secret lines. Search source folders (e.g. src/), use rg without --hidden, or add ${name === 'rg' ? "-g '!.env*'" : "--exclude='.env*'"}. ${SAFE_FILE}`;
  }
  if (pf) {
    if (pf.allPatterns) files = [];
    else {
      files = afterPattern();
    }
  }
  const globs = values
    .filter((v) => pf?.globOpts?.includes(v.opt) || v.opt === 'include')
    .map((v) => v.value);
  const all = [...files, ...sources, ...globs];
  if (all.some((f) => PROC_SECRET.test(f)))
    return `reading a process's environment or command line prints its secrets. ${SAFE_PROC}`;
  if (all.some(isSecretEnvFile))
    return `\`${name}\` on a .env file prints its secret values into the transcript. ${SAFE_FILE}`;
  return null;
}

function dumpRule(name, args) {
  if (name === 'printenv')
    return `\`printenv\` prints environment values, which can include secrets. ${SAFE_DUMP}`;
  const names = args.filter((a) => !isOption(a) && a !== '--');
  if (name === 'export' && names.length === 0)
    return `\`export${args.length ? ' ' + args.join(' ') : ''}\` lists every exported variable and its value. ${SAFE_DUMP}`;
  if (name === 'readonly' && names.length === 0)
    return `\`readonly\` with no names prints every read-only variable and its value. ${SAFE_DUMP}`;
  if (name === 'set' && args.length === 0)
    return `a bare \`set\` prints every shell variable and its value. ${SAFE_DUMP}`;
  if ((name === 'declare' || name === 'typeset') && names.length === 0) {
    if (args.some((a) => /^[-+][a-zA-Z]*[fF]/.test(a))) return null;
    return `\`${name}\` with no names prints every variable and its value. ${SAFE_DUMP}`;
  }
  return null;
}

function processRule(name, args) {
  if (name === 'pgrep') {
    const { flags } = scanArgs(args, 'uUgGPstFdLJ', [
      'parent',
      'pidfile',
      'terminal',
    ]);
    if (
      flags.some((f) =>
        ['f', 'a', 'l', 'full', 'list-full', 'list-name'].includes(f),
      )
    )
      return `\`pgrep\` with -f, -a or -l matches or prints full command lines, which can carry secrets. ${SAFE_PROC}`;
    return null;
  }
  if (name === 'ps') {
    // Columns limited with -o (or BSD `o`) to fields other than the command line are safe.
    const fields = [];
    let bsdEnv = false;
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      // Options that take a value (a user, pid, tty...): skip the value, it is not a cluster.
      if (
        /^-[a-zA-Z]*[UupCtGgqsN]$/.test(a) ||
        /^--(pid|ppid|user|group|tty|sid|sort)$/.test(a)
      ) {
        k++;
        continue;
      }
      if (a.startsWith('--format') || a === '-o' || a === '--o') {
        const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++k];
        if (v !== undefined) fields.push(v);
      } else if (/^-[a-zA-Z]*o/.test(a)) {
        const rest = a.slice(a.indexOf('o') + 1);
        const v = rest || args[++k];
        if (v !== undefined) fields.push(v);
        if (/^-[a-zA-Z]*E/.test(a)) bsdEnv = true;
      } else if (/^-[a-zA-Z]*E/.test(a)) bsdEnv = true;
      else if (/^[a-zA-Z]+$/.test(a)) {
        // BSD-style cluster: `aux`, `eww`, `axo`. `e` shows the environment.
        if (a.includes('e')) bsdEnv = true;
        if (a.includes('o')) {
          const v = a.slice(a.indexOf('o') + 1) || args[++k];
          if (v !== undefined) fields.push(v);
        }
      }
    }
    const names = fields
      .join(',')
      .split(/[\s,]+/)
      .map((f) => f.replace(/[=:].*$/, '').toLowerCase())
      .filter(Boolean);
    const UNSAFE = new Set(['args', 'command', 'cmd', 'cmdline']);
    if (!bsdEnv && names.length && !names.some((n) => UNSAFE.has(n)))
      return null;
    return `\`ps\` without a restricted column list prints full command lines, which can carry secrets. ${SAFE_PROC}`;
  }
  return null;
}

// --- inline code ---

const Q = `(?:'[^']*'|"[^"]*"|\`[^\`]*\`)`;
const JS_ACC = `(?:process\\.env|Bun\\.env|import\\.meta\\.env)(?:\\.[A-Za-z_$][\\w$]*|\\[\\s*${Q}\\s*\\])|Deno\\.env\\.get\\(\\s*${Q}\\s*\\)`;
const PY_ACC = `os\\.environ(?:\\.get\\(\\s*${Q}\\s*(?:,[^()]*)?\\)|\\[\\s*${Q}\\s*\\])|os\\.getenv\\(\\s*${Q}\\s*(?:,[^()]*)?\\)`;
const LANGS = {
  js: {
    presence: [
      new RegExp(`Boolean\\(\\s*(?:${JS_ACC})\\s*\\)`, 'g'),
      new RegExp(`!!\\s*(?:${JS_ACC})`, 'g'),
      new RegExp(`${Q}\\s+in\\s+(?:process\\.env|Bun\\.env)\\b`, 'g'),
      new RegExp(`Deno\\.env\\.has\\(\\s*${Q}\\s*\\)`, 'g'),
    ],
    reference:
      /process\s*(?:\.\s*env\b|\[\s*['"`]env['"`]\s*\])|\b(?:Deno|Bun)\s*\.\s*env\b|import\.meta\.env\b|\bprocess\.binding\b/,
    // `const { env } = process`, checked apart so a run of `{` cannot backtrack for long.
    destructure: /\{([^{}]{0,400})\}\s*=\s*process\b/g,
  },
  py: {
    presence: [
      new RegExp(`bool\\(\\s*(?:${PY_ACC})\\s*\\)`, 'g'),
      new RegExp(`${Q}\\s+in\\s+os\\.environ\\b`, 'g'),
    ],
    reference: /\benviron\b|\bgetenv\b/,
  },
  rb: {
    presence: [
      new RegExp(`ENV\\.(?:key|has_key|include)\\?\\(?\\s*${Q}\\s*\\)?`, 'g'),
      new RegExp(`!!\\s*ENV\\[\\s*${Q}\\s*\\]`, 'g'),
    ],
    reference: /\bENV\b/,
  },
  pl: {
    presence: [/\b(?:exists|defined)\s*\(?\s*\$ENV\{[^}]*\}\s*\)?/g],
    reference: /%ENV|\$ENV\s*\{|\bENV\b/,
  },
};
const CODE_ENV_FILE = new RegExp(
  `['"\`](?:[^'"\`\\s]*/)?\\.env(?!\\.(?:example|sample|template|dist)['"\`])[\\w.-]*['"\`]`,
);

export function codeReason(code, lang) {
  const spec = LANGS[lang];
  if (/\/proc\/[^'"`\s]*\/(?:environ|cmdline)/.test(code))
    return `inline code that reads a process's environment or command line prints its secrets. ${SAFE_PROC}`;
  if (CODE_ENV_FILE.test(code))
    return `inline code that opens a .env file can print its values. ${SAFE_FILE}`;
  let rest = code;
  for (const re of spec.presence) rest = rest.replace(re, 'true');
  const destructured = [
    ...(spec.destructure ? rest.matchAll(spec.destructure) : []),
  ].some((m) => /\benv\b/.test(m[1]));
  if (destructured || spec.reference.test(rest))
    return `inline code that reads environment values can print secrets. Print only presence, exactly like node -e 'console.log(Boolean(process.env.KEY))' or python3 -c 'import os; print(bool(os.getenv("KEY")))'.`;
  return null;
}

// Pulls the inline code out of an interpreter call. Returns { codes, stdin } where `stdin` means
// the program comes from standard input (a heredoc), or null when this is not an interpreter.
function inlineCode(name, args) {
  const codes = [];
  let lang;
  let fileArg = false;
  if (name === 'node' || name === 'nodejs' || name === 'bun') {
    lang = 'js';
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (/^--(eval|print)=/.test(a)) codes.push(a.slice(a.indexOf('=') + 1));
      else if (a === '--eval' || a === '--print') codes.push(args[++k] ?? '');
      else if (/^-[a-zA-Z]*[ep][a-zA-Z]*$/.test(a) && !a.startsWith('--'))
        codes.push(args[++k] ?? '');
      else if (
        a === '-r' ||
        a === '--require' ||
        a === '--import' ||
        a === '--input-type'
      )
        k++;
      else if (a === '-') break;
      else if (!isOption(a)) {
        // `bun run x`, `node script.js`: a program file; the rest are its arguments.
        fileArg = !(name === 'bun' && a === 'run');
        if (fileArg) break;
      }
    }
  } else if (name === 'deno') {
    lang = 'js';
    const k = args.indexOf('eval');
    if (k !== -1) {
      const { positionals } = scanArgs(args.slice(k + 1));
      if (positionals.length) codes.push(positionals[0]);
    } else fileArg = args.some((a) => !isOption(a) && a !== 'run' && a !== '-');
  } else if (
    /^python[\d.]*$/.test(name) ||
    name === 'pypy' ||
    name === 'pypy3'
  ) {
    lang = 'py';
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (/^-[a-zA-Z]*c/.test(a)) {
        const rest = a.slice(a.indexOf('c') + 1);
        codes.push(rest || (args[++k] ?? ''));
        break;
      }
      if (/^-[a-zA-Z]*[WXQ]$/.test(a)) k++;
      else if (/^-[a-zA-Z]*m/.test(a) || a === '-') {
        fileArg = a !== '-';
        break;
      } else if (!isOption(a)) {
        fileArg = true;
        break;
      }
    }
  } else if (name === 'ruby' || name === 'perl') {
    lang = name === 'ruby' ? 'rb' : 'pl';
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      const m = /^-[a-zA-Z0-9]*?[eE](.*)$/.exec(a);
      if (a === '-I' || a === '-r' || a === '-C')
        k++; // a value: `-I lib`, `-r json`
      else if (m && !a.startsWith('--')) codes.push(m[1] || (args[++k] ?? ''));
      else if (!isOption(a)) {
        fileArg = true;
        break;
      }
    }
  } else return null;
  return { lang, codes, stdin: codes.length === 0 && !fileArg };
}

// ---------------------------------------------------------------------------------------------
// Decision

// Printing a variable whose name says it holds a secret. Names only: the guard cannot see values.
const ECHOERS = new Set(['echo', 'printf', 'print']);
const SECRET_VAR =
  /SECRET|TOKEN|PASSW|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|_KEY$|CREDENTIAL|(^|_)DSN$|DATABASE_URL|_DB_URL$|REDIS_URL|CONNECTION_STRING|(^|_)AUTH$/i;
const SAFE_VAR = /_(FILE|PATH|DIR|NAME|ID)$/i;

// Whether a command's stdout reaches the transcript: not redirected to a file, and not piped into
// a program other than one that just prints its input again.
const ECHO_SINKS = new Set([...READERS, 'tee']);
function reachesTerminal(seg) {
  const out = seg.redirects.filter((r) => r.op === '>' || r.op === '>>');
  if (out.some((r) => !/^\/dev\/(stdout|stderr|tty|fd\/[12])$/.test(r.target)))
    return false;
  if (seg.pipeTo) {
    const next = unwrap(seg.pipeTo.words).words;
    if (next?.length && !ECHO_SINKS.has(basename(next[0]))) return false;
  }
  return true;
}

function judgeSegment(seg, depth) {
  const unwrapped = unwrap(seg.words);
  if (unwrapped.skip) return null;
  if (unwrapped.envDump)
    return `\`env\` with no command prints every environment value, which can include secrets. ${SAFE_DUMP}`;
  if (unwrapped.nested !== undefined) return judge(unwrapped.nested, depth + 1);
  const words = unwrapped.words;
  if (!words.length) return readerRule('', [], seg.redirects);
  const name = basename(words[0]);
  const args = words.slice(1);

  const reason =
    dumpRule(name, args) ??
    readerRule(name, args, seg.redirects) ??
    processRule(name, args);
  if (reason) return reason;

  if (ECHOERS.has(name) && reachesTerminal(seg)) {
    const secret = seg.expands.find(
      (v) => SECRET_VAR.test(v) && !SAFE_VAR.test(v),
    );
    if (secret)
      return `\`${name}\` of $${secret} prints a secret value. Print only presence: [ -n "$${secret}" ] && echo set.`;
  }
  if (name === 'eval') return judge(args.join(' '), depth + 1);
  if (SHELLS.has(name)) {
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))
        return k + 1 < args.length ? judge(args[k + 1], depth + 1) : null;
      if (/^[-+][a-zA-Z]*[oO]$/.test(a))
        k++; // `-o pipefail`
      else if (!isOption(a) && !a.startsWith('+')) return null; // a script file
    }
    for (const body of seg.heredocs) {
      const r = judge(body, depth + 1);
      if (r) return r;
    }
    for (const r of seg.redirects)
      if (r.op === '<<<') {
        const out = judge(r.target, depth + 1);
        if (out) return out;
      }
    return null;
  }
  const inline = inlineCode(name, args);
  if (inline) {
    const sources = [...inline.codes];
    if (inline.stdin) {
      sources.push(...seg.heredocs);
      for (const r of seg.redirects) if (r.op === '<<<') sources.push(r.target);
    }
    for (const code of sources) {
      const r = codeReason(code, inline.lang);
      if (r) return r;
    }
  }
  return null;
}

function judge(command, depth = 0) {
  if (depth > 8) return null;
  for (const seg of parseCommands(command)) {
    const reason = judgeSegment(seg, depth);
    if (reason) return reason;
  }
  return null;
}

// Returns a denial reason, or null when the command is allowed.
// `options.hasEnvFile(dir)` lets the caller say whether a folder holds a .env file (true or
// false), or null when it cannot tell.
export function secretDecision(command, options = {}) {
  if (typeof command !== 'string' || !command.trim()) return null;
  envProbe = options.hasEnvFile ?? null;
  try {
    return judge(command);
  } finally {
    envProbe = null;
  }
}
