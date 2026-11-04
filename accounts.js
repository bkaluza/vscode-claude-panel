// Accounts: one Claude Code config directory each, the one CLAUDE_CONFIG_DIR selects, from claudeSessions.accounts.
// Plain functions, no VS Code, so the tests can run them.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { claudeDir } = require('./transcripts');

const COLOR_NAMES = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink'];

/** A folder with its symlinks resolved; as it is when it doesn't exist (yet). */
function realDir(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

/**
 * The accounts to read: the setting's entries with a label and an absolute or ~ configDir, the first one for a
 * folder winning, also when two names lead to the same folder (a symlink). With none, the one account Claude Code
 * uses here: ~/.claude or $CLAUDE_CONFIG_DIR, unlabelled.
 */
function resolve(entries, { command = 'claude', env = process.env, home = os.homedir(), realpath = realDir } = {}) {
  const out = [];
  const seen = new Set();
  for (const e of Array.isArray(entries) ? entries : []) {
    const label = typeof e?.label === 'string' ? e.label.trim() : '';
    const raw = typeof e?.configDir === 'string' ? e.configDir.trim() : '';
    if (!label || !(raw === '~' || raw.startsWith('~/') || path.isAbsolute(raw))) continue;
    const dir = claudeDir({ CLAUDE_CONFIG_DIR: raw }, home);
    const real = realpath(dir);
    if (seen.has(real)) continue;
    seen.add(real);
    out.push({
      label,
      dir,
      command: (typeof e.command === 'string' && e.command.trim()) || command,
      color: COLOR_NAMES.includes(e.color) ? e.color : '',
    });
  }
  return out.length ? out : [{ label: '', dir: claudeDir(env, home), command, color: '' }];
}

/** The account whose config directory holds `file` (a transcript), if any. */
function ofFile(accounts, file) {
  return typeof file === 'string' ? accounts.find((a) => file.startsWith(a.dir + path.sep)) : undefined;
}

/**
 * The environment a session terminal for `account` needs: its folder in CLAUDE_CONFIG_DIR, except ~/.claude, which
 * works only with the variable unset (set to ~/.claude, Claude Code looks for its login elsewhere and starts logged
 * out); null unsets it. undefined: nothing to add, as when no accounts are configured.
 */
function terminalEnv(account, { env = process.env, home = os.homedir() } = {}) {
  if (!account?.label) return undefined;
  if (account.dir !== path.join(home, '.claude')) return { CLAUDE_CONFIG_DIR: account.dir };
  return (env.CLAUDE_CONFIG_DIR || '').trim() ? { CLAUDE_CONFIG_DIR: null } : undefined;
}

/**
 * Whether a terminal created with `env` runs the account whose terminalEnv() is `want`, so it can be reused. Only on
 * positive evidence: a terminal VS Code revived after a reload has no env of its own and inherits VS Code's, so
 * one that must have the variable unset (null) matches only a terminal created with it unset.
 */
function sameEnv(env, want) {
  const has = env && Object.prototype.hasOwnProperty.call(env, 'CLAUDE_CONFIG_DIR') ? env.CLAUDE_CONFIG_DIR : undefined;
  if (want?.CLAUDE_CONFIG_DIR === null) return has === null;
  return (has || '') === (want?.CLAUDE_CONFIG_DIR || '');
}

/** Is this the account in ~/.claude (also through a symlink), Claude Code's default? */
function isDefault(account, { home = os.homedir(), realpath = realDir } = {}) {
  return !!account && realpath(account.dir) === realpath(path.join(home, '.claude'));
}

/**
 * What the command typed into a terminal sets for the account, in POSIX shells, so a reused or revived terminal
 * (no env of its own) or a shell profile can't put it on another account: { CLAUDE_CONFIG_DIR: dir } for an account
 * elsewhere, { CLAUDE_CONFIG_DIR: null } (unset) for ~/.claude. Only once it matters: several accounts, or
 * CLAUDE_CONFIG_DIR set in VS Code's own environment. undefined with no accounts configured (unchanged), and on
 * Windows, where the terminal's env does it.
 */
function commandEnv(account, { several = false, env = process.env, home = os.homedir(), platform = process.platform, realpath = realDir } = {}) {
  if (!account?.label || platform === 'win32') return undefined;
  if (!several && !(env.CLAUDE_CONFIG_DIR || '').trim()) return undefined;
  return { CLAUDE_CONFIG_DIR: isDefault(account, { home, realpath }) ? null : account.dir };
}

/**
 * `want` (from commandEnv or terminalEnv) as words in front of a command: `CLAUDE_CONFIG_DIR=<dir> ` or
 * `unset CLAUDE_CONFIG_DIR && `. Not `env -u`: env runs only programs, and the command can be a shell alias.
 */
function envPrefix(want, quote) {
  if (!want || !('CLAUDE_CONFIG_DIR' in want)) return '';
  return want.CLAUDE_CONFIG_DIR === null ? 'unset CLAUDE_CONFIG_DIR && ' : `CLAUDE_CONFIG_DIR=${quote(want.CLAUDE_CONFIG_DIR)} `;
}

/**
 * One transcript per session id when accounts share one (a copied config dir, a symlinked projects/): for a
 * running session the copy in its live record's account (`liveAccount(id)`, a dir), else the newer one; on a tie,
 * the first account's. `infos` are readSession()s, in account order.
 */
function pickTranscripts(infos, accounts, liveAccount = () => undefined) {
  const out = new Map();
  for (const s of infos) {
    const prev = out.get(s.id);
    if (!prev) {
      out.set(s.id, s);
      continue;
    }
    const own = liveAccount(s.id);
    const inOwn = (x) => !!own && ofFile(accounts, x.file)?.dir === own;
    if (inOwn(prev) !== inOwn(s)) {
      if (inOwn(s)) out.set(s.id, s);
    } else if ((s.mtime || 0) > (prev.mtime || 0)) out.set(s.id, s);
  }
  return out;
}

/** One live record per session id when two accounts list it: the most recently updated, the first account's on a tie. */
function pickLive(records) {
  const at = (d) => Math.max(d.updatedAt || 0, d.statusUpdatedAt || 0, d.startedAt || 0);
  const out = new Map();
  for (const d of records) {
    const prev = out.get(d.sessionId);
    if (!prev || at(d) > at(prev)) out.set(d.sessionId, d);
  }
  return [...out.values()];
}

/** A folder as you'd type it: ~ for your home directory. */
function display(dir, home = os.homedir()) {
  return dir === home ? '~' : dir.startsWith(home + path.sep) ? `~${dir.slice(home.length)}` : dir;
}

module.exports = { resolve, ofFile, terminalEnv, sameEnv, isDefault, commandEnv, envPrefix, pickTranscripts, pickLive, display };
