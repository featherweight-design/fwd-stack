// The per-project settings the fwd plugin's skills and hooks read: `.claude/fwd.json` in the
// project, layered over `fwd.json` in the Claude config folder (`~/.claude`, or
// CLAUDE_CONFIG_DIR) for settings that hold on this machine whatever the project.
//
//   {
//     "ownApp": true,                                   // one of the owner's own apps
//     "neon": {
//       "protected": { "br-…": "production" },          // read-only Neon branches/endpoints
//       "readOnlyCompute": { "br-…": "ep-…" }           // run_sql there must use this replica
//     },
//     "sessionBudget": { "warnTokens": 150000,             // context size the first warning comes at
//                        "compactWindow": 300000 },        // the machine's autoCompactWindow
//     "orchestrator": { "maxLanes": 3, "maxOpusLanes": 1 } // rotateAt: optional ceiling, off by default
//   }
//
// Objects merge key by key, and the project wins on a conflict. Protected Neon branches are a
// union, so a machine-wide list can never be narrowed by a project file. A missing or unreadable
// file is an empty one: a hook that crashed on a typo would stop guarding anything.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

// A missing file is no config. A file that exists but cannot be read or parsed throws: reading it
// as empty would drop its protected ids, so a typo in fwd.json would lift the Neon guard.
const readJson = (path) => {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  return JSON.parse(text);
};

export function mergeConfig(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {}))
    out[k] = isObject(v) && isObject(out[k]) ? mergeConfig(out[k], v) : v;
  return out;
}

export function loadConfig(
  env = process.env,
  home = homedir(),
  read = readJson,
) {
  const configDir = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  // `invalid` lists the files that exist but are not a JSON object. The Neon hook denies while it
  // is non-empty; everything else reads the rest of the config as usual.
  const invalid = [];
  const load = (path) => {
    let v;
    try {
      v = read(path);
    } catch {
      v = undefined;
    }
    if (isObject(v)) return v;
    invalid.push(path);
    return {};
  };
  const machine = load(join(configDir, 'fwd.json'));
  const project = env.CLAUDE_PROJECT_DIR
    ? load(join(env.CLAUDE_PROJECT_DIR, '.claude', 'fwd.json'))
    : {};
  const merged = mergeConfig(machine, project);
  // Only objects join the union: a project setting `protected` to null or [] cannot wipe the
  // machine's list, which mergeConfig alone would let it do.
  const ids = (v) => (isObject(v) ? v : {});
  merged.neon = {
    ...(isObject(merged.neon) ? merged.neon : {}),
    protected: {
      ...ids(machine.neon?.protected),
      ...ids(project.neon?.protected),
    },
  };
  // Read-only computes are a union like `protected`, but the machine wins per branch: a project
  // file could otherwise point a machine-mapped branch at a read-write compute. Only nonempty
  // string values count, so null or "" cannot clear an entry. Branch ids are lowercased, as the
  // guard matches them: otherwise `BR-PROD` in a project would sit beside the machine's `br-prod`.
  const computes = (v) =>
    Object.fromEntries(
      Object.entries(isObject(v) ? v : {})
        .filter(([, ep]) => typeof ep === 'string' && ep)
        .map(([branch, ep]) => [branch.toLowerCase(), ep]),
    );
  merged.neon.readOnlyCompute = {
    ...computes(project.neon?.readOnlyCompute),
    ...computes(machine.neon?.readOnlyCompute),
  };
  merged.invalid = invalid;
  return merged;
}
