// What a session handed you, as the Claude desktop app lists a session's outputs: artifacts and docs it published,
// pull and merge requests it opened, files it sent you and plans you approved. Read in the same incremental pass as
// the rest of the transcript, all of it (early results matter), and only while claudeSessions.showResults is on.
// A call and its result are on different lines, maybe in different reads, so calls that can give a result wait in
// `calls`. api-request lines replay calls and results with the same ids, even before the result, and are skipped.
const path = require('path');

const CAP = 50; // results kept per session
const WAITING = 20; // calls kept waiting for their result (an interrupted one never gets one)
const CALL_RE =
  /"type":"tool_use","id":"(toolu_\w+)","name":"(Artifact|SendUserFile|ExitPlanMode|mcp__claude_ai_Claude_Docs__batch|mcp__[^"]*__create_merge_request)"/g;
const GIT_RE = /"gitOperation":\{/g; // Claude Code's note on a Bash result that pushed, committed or opened a PR
const FRAME_RE = /"frame":\{[^}]*?"url":"(https:\/\/claude\.ai\/[^"]+)"/;
const CLAUDE_URL = /^https:\/\/claude\.ai\/\S+$/;
const PR_URL = /^https:\/\/[^/\s]+\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)$/;
const MR_URL = /^https:\/\/[^/\s]+\/\S+\/-\/merge_requests\/(\d+)$/;

const str = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, 120) : '');
const base = (p) => str(String(p).split(/[\\/]/).pop());
const heading = (md) => str((/^#{1,6}\s+(.+)$/m.exec(typeof md === 'string' ? md : '') || [])[1]);
const blocks = (d) => (Array.isArray(d?.message?.content) ? d.message.content : []);
const textOf = (c) =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';

// The entry on the line around index i, unless it's a replayed request, a subagent's, or not whole JSON.
function lineAt(text, i) {
  const start = text.lastIndexOf('\n', i) + 1;
  if (text.startsWith('{"type":"api-request', start)) return undefined;
  const end = text.indexOf('\n', i);
  try {
    const d = JSON.parse(text.slice(start, end < 0 ? text.length : end));
    return d && !d.isSidechain ? d : undefined;
  } catch {
    return undefined;
  }
}

// What a call keeps until its result: just enough for the row. undefined: this call publishes nothing.
function waiting(name, input) {
  const i = input || {};
  if (name === 'Artifact') return !i.action || i.action === 'publish' ? { kind: 'artifact', title: str(i.title) } : undefined;
  if (name === 'SendUserFile') return { kind: 'file', files: Array.isArray(i.files) ? i.files : [] };
  if (name === 'ExitPlanMode') return { kind: 'plan', title: heading(i.plan), file: i.planFilePath };
  if (name.startsWith('mcp__claude_ai_Claude_Docs__')) {
    return i.container?.create ? { kind: 'doc', title: str(i.container.create.name) } : undefined;
  }
  return { kind: 'mr', title: str(i.title) };
}

// The rows a successful result gives.
function found(call, b, d) {
  const r = d.toolUseResult;
  const at = Date.parse(d.timestamp) || 0;
  const row = (key, title) => ({ key, kind: call.kind, title: title || base(key), at });
  const abs = (p) => typeof p === 'string' && path.isAbsolute(p);
  if (call.kind === 'artifact') return CLAUDE_URL.test(r?.url) ? [row(r.url, str(r.title) || call.title)] : [];
  if (call.kind === 'doc') {
    const url = (FRAME_RE.exec(textOf(b.content)) || [])[1];
    return url ? [row(url, call.title)] : [];
  }
  if (call.kind === 'mr') {
    let o;
    try {
      o = JSON.parse(textOf(b.content));
    } catch {
      return [];
    }
    const m = MR_URL.exec(o?.web_url || o?.url);
    return m ? [row(m[0], `!${m[1]} ${call.title}`.trim())] : [];
  }
  if (call.kind === 'file') {
    const files = Array.isArray(r?.attachments) ? r.attachments.map((a) => a?.path) : call.files;
    return files.filter(abs).map((f) => row(f));
  }
  const file = abs(r?.filePath) ? r.filePath : call.file;
  return abs(file) ? [row(file, call.title)] : [];
}

// A PR Claude Code noted the session opened, on a Bash result, whatever the command around gh pr create.
function pr(d) {
  const p = d?.type === 'user' ? d.toolUseResult?.gitOperation?.pr : undefined;
  const m = p?.action === 'created' && PR_URL.exec(p.url);
  return m ? { key: m[0], kind: 'pr', title: `#${m[2]} ${m[1]}`, at: Date.parse(d.timestamp) || 0 } : undefined;
}

// One row per link or path: the newest title and time win. Over CAP, the oldest goes.
function add(state, row) {
  const prev = state.items.get(row.key);
  state.items.set(row.key, { key: row.key, kind: row.kind, title: row.title || prev?.title || '', at: Math.max(row.at, prev?.at || 0) });
  if (state.items.size <= CAP) return;
  let oldest;
  for (const r of state.items.values()) if (!oldest || r.at < oldest.at) oldest = r;
  state.items.delete(oldest.key);
}

let on = false;

/** Reads results or not (claudeSessions.showResults); turned on, the transcripts need reading again from the start. */
const enable = (value) => (on = !!value);

/** Folds a chunk of whole transcript lines into `state` ({ calls, items }, created on first use) and returns it. */
function scan(state, text) {
  if (!on) return state;
  state ||= { calls: new Map(), items: new Map() };
  const here = new Map(); // calls in this chunk → where: their result comes after them
  let m;
  CALL_RE.lastIndex = 0;
  while ((m = CALL_RE.exec(text))) {
    const d = lineAt(text, m.index);
    const b = d?.type === 'assistant' && blocks(d).find((x) => x?.id === m[1]);
    const call = b && waiting(m[2], b.input);
    if (!call) continue;
    state.calls.set(m[1], call);
    here.set(m[1], m.index);
  }
  for (const [id, call] of state.calls) {
    const needle = `"tool_use_id":"${id}"`;
    for (let i = text.indexOf(needle, here.get(id) || 0); i >= 0; i = text.indexOf(needle, i + 1)) {
      const d = lineAt(text, i);
      const b = d?.type === 'user' && blocks(d).find((x) => x?.type === 'tool_result' && x.tool_use_id === id);
      if (!b) continue;
      state.calls.delete(id);
      if (!b.is_error) for (const row of found(call, b, d)) add(state, row);
      break;
    }
  }
  while (state.calls.size > WAITING) state.calls.delete(state.calls.keys().next().value);
  if (text.includes('"gitOperation":{')) {
    GIT_RE.lastIndex = 0;
    while ((m = GIT_RE.exec(text))) {
      const row = pr(lineAt(text, m.index));
      if (row) add(state, row);
    }
  }
  return state;
}

/** The card's rows, newest first; undefined when there are none. */
function forPayload(state) {
  return state?.items.size ? [...state.items.values()].sort((a, b) => b.at - a.at) : undefined;
}

/** A recorded result by its key (link or path): the only ones the panel may open. */
const get = (state, key) => (typeof key === 'string' ? state?.items.get(key) : undefined);

module.exports = { enable, scan, forPayload, get };
