// What's running across every live session (this window, other terminals, the Claude desktop app): the panel's
// summary chips and the status bar. Loaded by the panel webview, and by the extension and tests through require.
(function (root) {
  // What each chip counts and filters by. A session is { status, open, agents: [{ state }] }; status is set only
  // while it's live. 'starting' (a terminal we just opened) isn't working yet.
  const KINDS = {
    working: (s) => s.status === 'busy',
    waiting: (s) => s.status === 'waiting',
    agents: (s) => !!s.status && runningAgents(s) > 0,
  };

  const runningAgents = (s) => (s.agents || []).filter((a) => a.state === 'run' && !a.workflow).length;

  /** Does a session count for this chip? */
  const matches = (kind, s) => !!KINDS[kind]?.(s);

  /**
   * Totals across `sessions`, overall and split into this window (`open`) and elsewhere:
   * { working, waiting, agents, here: {…}, elsewhere: {…} }. agents counts running subagents, not sessions.
   */
  function tally(sessions) {
    const zero = () => ({ working: 0, waiting: 0, agents: 0 });
    const out = { ...zero(), here: zero(), elsewhere: zero() };
    for (const s of sessions || []) {
      if (!s?.status) continue;
      const add = (k, n) => {
        out[k] += n;
        out[s.open ? 'here' : 'elsewhere'][k] += n;
      };
      if (KINDS.working(s)) add('working', 1);
      if (KINDS.waiting(s)) add('waiting', 1);
      add('agents', runningAgents(s));
    }
    return out;
  }

  /** The chips' words: "3 working", "1 needs you" / "2 need you", "1 agent running" / "4 agents running". */
  function label(kind, n) {
    if (kind === 'working') return `${n} working`;
    if (kind === 'waiting') return `${n} need${n === 1 ? 's' : ''} you`;
    return `${n} agent${n === 1 ? '' : 's'} running`;
  }

  const api = { tally, matches, label, runningAgents, KINDS: Object.keys(KINDS) };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Tally = api;
})(this);
