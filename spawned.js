// Sessions a session started with `claude --bg`, from the "backgrounded · <id> · <name>" its transcript records,
// and the note typed into it when one finishes. Plain functions, no VS Code, so the tests can run them.

const CAP = 50; // children kept per session
const ANCHOR = /"stdout":"backgrounded (?:·|\\u00b7) [0-9a-f]{8}/g;
const STDOUT_RE = /^backgrounded · ([0-9a-f]{8}) · ([^\n]*)/;

// The parsed line at `i`. api-request lines replay tool results, and sidechains are a subagent's.
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

/** Folds a transcript chunk (whole lines) into `state`: Map short id → { short, name, at }. */
function scan(state, text) {
  if (!text.includes('"stdout":"backgrounded ')) return state;
  for (const m of text.matchAll(ANCHOR)) {
    const d = lineAt(text, m.index);
    const out = typeof d?.toolUseResult?.stdout === 'string' && STDOUT_RE.exec(d.toolUseResult.stdout);
    if (!out) continue;
    state = state || new Map();
    state.delete(out[1]);
    state.set(out[1], { short: out[1], name: out[2].trim(), at: Date.parse(d.timestamp) || 0 });
    if (state.size > CAP) state.delete(state.keys().next().value);
  }
  return state;
}

/** The full session id that `short` starts, when exactly one of `ids` does. */
function resolve(short, ids) {
  let found = '';
  for (const id of ids) {
    if (!id.startsWith(short)) continue;
    if (found && found !== id) return '';
    found = id;
  }
  return found;
}

/** A child's turn ended (busy → idle) or it exited while working (busy → gone). */
const finished = (before, after) => before === 'busy' && (after === 'idle' || after === undefined);

/** What the parent is told. Panel-authored: never the child's output, since typed text is the user speaking. */
function note(name, short) {
  const clean = String(name || '')
    .replace(/\s+/g, ' ')
    .replace(/[^\w .-]/g, '')
    .trim()
    .slice(0, 60);
  const who = clean ? `"${clean}" (${short})` : short;
  return `Background session ${who} finished. See its output with: claude logs ${short}`;
}

module.exports = { CAP, scan, resolve, finished, note };
