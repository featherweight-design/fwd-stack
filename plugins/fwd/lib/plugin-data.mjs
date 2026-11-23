// The plugin's persistent data folder, where state that must survive an update lives.
//
// Claude Code exports CLAUDE_PLUGIN_DATA to hooks, but not to commands Claude runs through Bash,
// so the folder is also derived from its documented name: `<config>/plugins/data/<id>`, where
// <id> is `fwd@fwd-stack` with every character outside [A-Za-z0-9_-] replaced by `-` and
// <config> is CLAUDE_CONFIG_DIR when set, else `~/.claude`. The two can differ: an inline or
// renamed install gets another <id>, so a hook's CLAUDE_PLUGIN_DATA is not the derived name, and
// state written from Bash lands in a folder that hook never reads. Readers that must not miss it
// use pluginDataDirs.
import { homedir } from 'node:os';
import { join } from 'node:path';

const derivedDir = (env, home) =>
  join(
    env.CLAUDE_CONFIG_DIR || join(home, '.claude'),
    'plugins',
    'data',
    'fwd-fwd-stack',
  );

export function pluginDataDir(env = process.env, home = homedir()) {
  return env.CLAUDE_PLUGIN_DATA || derivedDir(env, home);
}

// Every folder a writer or the kit could have used: the exported one, then the derived one.
export function pluginDataDirs(env = process.env, home = homedir()) {
  return [...new Set([pluginDataDir(env, home), derivedDir(env, home)])];
}
