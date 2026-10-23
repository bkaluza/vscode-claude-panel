// Claude Code's files, read without the VS Code API (so this can be unit-tested): where they live, what a
// transcript says about its session as it grows, and whether any of it still looks the way we expect.
const fs = require('fs');
const os = require('os');
const path = require('path');
const usage = require('./usage');
const subagents = require('./subagents');
const activity = require('./activity');
const results = require('./results');

/** Claude Code's config dir: $CLAUDE_CONFIG_DIR when set (Claude Code's own override), else ~/.claude. */
function claudeDir(env = process.env, home = os.homedir()) {
  const d = (env.CLAUDE_CONFIG_DIR || '').trim();
  if (!d) return path.join(home, '.claude');
  return path.resolve(d === '~' ? home : d.startsWith('~/') ? path.join(home, d.slice(2)) : d);
}

// Claude Code names a project folder after the cwd with every non-alphanumeric char replaced by '-'.
const encodeCwd = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');

/**
 * Where a session's transcript is when it isn't in the workspace's project folders (started in another folder):
 * the folder of the cwd its live record gives, else any project folder, if it changed directory since. No fold
 * for Windows casing as in projectDirs(): its file system ignores case anyway. undefined: none written yet.
 */
async function findTranscript(projectsDir, id, cwd) {
  if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) return undefined;
  const name = `${id}.jsonl`;
  const isFile = (f) => fs.promises.stat(f).then((st) => st.isFile(), () => false);
  const first = typeof cwd === 'string' && cwd ? path.join(projectsDir, encodeCwd(cwd), name) : undefined;
  if (first && (await isFile(first))) return first;
  for (const d of await fs.promises.readdir(projectsDir, { withFileTypes: true }).catch(() => [])) {
    const f = path.join(projectsDir, d.name, name);
    if (d.isDirectory() && f !== first && (await isFile(f))) return f;
  }
  return undefined;
}

const STR = '"((?:[^"\\\\]|\\\\.)*)"';
const FIELDS = [
  ['name', 'agent-name', 'agentName'],
  ['customTitle', 'custom-title', 'customTitle'],
  ['aiTitle', 'ai-title', 'aiTitle'],
  ['color', 'agent-color', 'agentColor'],
  ['lastPrompt', 'last-prompt', 'lastPrompt'],
].map(([field, type, key]) => [field, new RegExp(`"type":"${type}","${key}":${STR}`, 'g')]);
const BRANCH_RE = new RegExp(`"gitBranch":${STR}`, 'g');
const CWD_RE = new RegExp(`"cwd":${STR}`);

function unjson(s) {
  try {
    return JSON.parse('"' + s + '"');
  } catch {
    return s;
  }
}

function lastMatch(text, re) {
  re.lastIndex = 0;
  let m, last;
  while ((m = re.exec(text))) last = m[1];
  return last === undefined ? undefined : unjson(last);
}

/** Folds a run of whole transcript lines, appended since the last call, into the session's info. */
function readChunk(info, text) {
  for (const [field, re] of FIELDS) {
    const v = lastMatch(text, re);
    if (v !== undefined) info[field] = v;
  }
  info.branch = lastMatch(text, BRANCH_RE) ?? info.branch;
  if (!info.cwd) info.cwd = unjson((CWD_RE.exec(text) || [])[1] || '');
  info.hasMessages = info.hasMessages || text.includes('"type":"user"');
  let lines = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lines++;
  info.lines = (info.lines || 0) + lines;
  Object.assign(info, usage.scan(text));
  subagents.scanText(info, text); // subagent completions, for subagents.update()
  info.act = activity.scan(info.act, text); // what it's doing now, for the card's activity line
  info.results = results.scan(info.results, text); // what it published, opened or sent you
}

/** file → { offset, info } — session files are append-only, so only new bytes are parsed */
const fileCache = new Map();

/** Reads every transcript again from the start on the next scan (results turned on). */
const forget = () => fileCache.clear();

async function readSession(file, cache = fileCache) {
  const st = await fs.promises.stat(file);
  let c = cache.get(file);
  if (!c || st.size < c.offset) {
    c = { offset: 0, info: { id: path.basename(file, '.jsonl'), file } };
    cache.set(file, c);
  }
  if (st.size > c.offset) {
    const fh = await fs.promises.open(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - c.offset);
      await fh.read(buf, 0, buf.length, c.offset);
      const end = buf.lastIndexOf(10) + 1; // whole lines only; a half-written one is read next time
      const text = buf.toString('utf8', 0, end);
      c.offset += end;
      readChunk(c.info, text);
    } finally {
      await fh.close();
    }
  }
  c.info.mtime = st.mtimeMs;
  return c.info;
}

/** The session's name, when it has one: your alias, then Claude's names for it. Terminal tabs get this. */
function pickName({ alias, session: s = {}, live: l } = {}) {
  const liveName = l?.nameSource === 'user' ? l.name : undefined;
  return alias || s.name || liveName || s.customTitle || s.aiTitle || undefined;
}

/** What the panel calls a session: its name, then its last prompt, then its id. */
function pickTitle(id, opts = {}) {
  return pickName(opts) || opts.session?.lastPrompt || id.slice(0, 8);
}

/** A live record (sessions/<pid>.json) with everything the panel reads from it. */
const isLiveRecord = (d) =>
  !!d && typeof d.sessionId === 'string' && d.pid > 0 && typeof d.status === 'string';

// A transcript this long with no user message isn't one we can read.
const UNREADABLE_LINES = 10;

/**
 * '' while Claude Code's files look as expected; otherwise a short notice for the panel. That's when they exist
 * but none parse into the expected shape: live records without sessionId/pid/status, or transcripts with plenty
 * of lines and no user messages. live: { parsed, ok, version } from reading sessions/; infos: readSession()s.
 */
function formatNotice(live = {}, infos = []) {
  const liveOdd = live.parsed > 0 && !live.ok;
  const transcriptsOdd = !infos.some((i) => i.hasMessages) && infos.some((i) => i.lines >= UNREADABLE_LINES);
  if (!liveOdd && !transcriptsOdd) return '';
  const version = typeof live.version === 'string' && live.version ? ` (Claude Code ${live.version})` : '';
  return `This Claude Code version's session format isn't recognised${version}. Some details may be missing.`;
}

module.exports = {
  claudeDir,
  encodeCwd,
  findTranscript,
  readChunk,
  readSession,
  forget,
  pickName,
  pickTitle,
  isLiveRecord,
  formatNotice,
};
