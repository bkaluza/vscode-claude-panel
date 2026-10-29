// Subagents of a Claude Code session: what each one is, and whether it is still running.
//
// They live next to the session transcript, in <sessionId>/subagents/: agent-<id>.jsonl (transcript) and
// agent-<id>.meta.json ({ agentType, description, toolUseId, parentAgentId?, stoppedByUser?, ... }).
// Nothing in those files says "finished"; that is written to whoever spawned the agent (the session, or the
// parent agent for nested ones):
//   - background agents (all of them, in practice): a <task-notification> with <task-id>, <status>;
//   - foreground agents: the Agent tool_result for the meta's toolUseId (one that isn't "Async agent launched").
// So the session transcript is scanned for those in the same incremental pass that reads it (scanText), and
// parent agents' transcripts are scanned the same way, only when they have children.
// A Workflow run's agents are in subagents/workflows/<runId>/, with a journal.jsonl that says which have returned;
// the run itself is done once the session gets the <task-notification> for the task id its launch result named.
const fs = require('fs');
const path = require('path');
const activity = require('./activity');

const RECENT = 100; // agents per session sent to the panel, newest first
const QUIET = 10 * 60 * 1000; // a running agent with no transcript write for this long is shown as quiet
const RESUME_SLACK = 15000; // transcript written this long after its completion = the agent was resumed

const NOTE_RE = /<task-id>([\w-]+)<\/task-id>/g;
const STATUS_RE = /<status>(\w+)<\/status>/;
const TS_RE = /"timestamp":"([^"]+)"/;
const CALL_RE = /"id":"(toolu_\w+)","name":"(?:Agent|Task)"/g;
const RESULT_RE = /"tool_use_id":"(toolu_\w+)"/g;
const LAUNCHED_RE = /Async agent launched|Fork started/;
const WF_LAUNCH_RE = /"taskType":"local_workflow"/g;

/** sessionId → { dir, key, agents: [...] } for sessions the panel asked about */
const bySession = new Map();
/** agent transcript → { offset, info } for parent agents scanned incrementally */
const agentScans = new Map();
/** workflow journal → { offset, mtime, done: Map(agentId → status), phase } */
const journals = new Map();
/** meta file → { mtime, meta }; agent transcript → first timestamp */
const metaCache = new Map();
const startCache = new Map();
/** ids the panel listed since the last update(), and the ones that update() refreshed */
let requested = new Set();
let wanted = new Set();

function lineAt(text, i) {
  const start = text.lastIndexOf('\n', i) + 1;
  let end = text.indexOf('\n', i);
  if (end < 0) end = text.length;
  return text.slice(start, end);
}

function lineTime(text, i) {
  const m = TS_RE.exec(lineAt(text, i));
  return m ? Date.parse(m[1]) || 0 : 0;
}

/**
 * Collects completions from newly appended transcript text into `info`:
 * info.agentDone (agentId → { at, status }) and info.toolDone (toolUseId → at).
 */
const ago = (ms) => {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

function scanText(info, text) {
  if (text.includes('<task-id>')) {
    NOTE_RE.lastIndex = 0;
    let m;
    while ((m = NOTE_RE.exec(text))) {
      const status = (STATUS_RE.exec(text.slice(m.index, m.index + 1500)) || [])[1];
      if (!status || status === 'running') continue;
      const at = lineTime(text, m.index);
      const prev = (info.agentDone ||= new Map()).get(m[1]);
      if (!prev || at >= prev.at) info.agentDone.set(m[1], { at, status });
    }
  }
  if (text.includes('"name":"Agent"') || text.includes('"name":"Task"')) {
    CALL_RE.lastIndex = 0;
    let m;
    while ((m = CALL_RE.exec(text))) (info.agentCalls ||= new Set()).add(m[1]);
  }
  if (info.agentCalls?.size) {
    RESULT_RE.lastIndex = 0;
    let m;
    while ((m = RESULT_RE.exec(text))) {
      if (!info.agentCalls.has(m[1])) continue;
      if (LAUNCHED_RE.test(text.slice(m.index, m.index + 300))) continue;
      (info.toolDone ||= new Map()).set(m[1], lineTime(text, m.index));
      info.agentCalls.delete(m[1]);
    }
  }
  if (text.includes('"local_workflow"')) {
    WF_LAUNCH_RE.lastIndex = 0;
    let m;
    while ((m = WF_LAUNCH_RE.exec(text))) {
      const near = lineAt(text, m.index);
      const run = (/"runId":"(wf_[\w-]+)"/.exec(near) || [])[1];
      const task = (/"taskId":"(\w+)"/.exec(near) || [])[1];
      if (run && task) (info.workflows ||= new Map()).set(run, { task, name: (/"workflowName":"([^"]*)"/.exec(near) || [])[1] || run });
    }
  }
}

/** The whole lines written to `file` between `offset` and `size`. */
async function appended(file, offset, size) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(size - offset);
    await fh.read(buf, 0, buf.length, offset);
    const end = buf.lastIndexOf(10) + 1;
    return { text: buf.toString('utf8', 0, end), end };
  } finally {
    await fh.close();
  }
}

async function scanAgentFile(file, size) {
  let c = agentScans.get(file);
  if (!c || size < c.offset) {
    c = { offset: 0, info: {} };
    agentScans.set(file, c);
  }
  if (size > c.offset) {
    const { text, end } = await appended(file, c.offset, size);
    scanText(c.info, text);
    c.info.act = activity.scan(c.info.act, text, { sidechain: true });
    c.offset += end;
  }
  return c.info;
}

async function readJournal(file) {
  const st = await fs.promises.stat(file);
  let j = journals.get(file);
  if (!j || st.size < j.offset) journals.set(file, (j = { offset: 0, done: new Map(), phase: '' }));
  j.mtime = st.mtimeMs;
  if (st.size > j.offset) {
    const { text, end } = await appended(file, j.offset, st.size);
    for (const line of text.split('\n')) {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type === 'started') j.phase = e.phase || j.phase;
      else if (e.agentId && e.type !== 'launched') j.done.set(e.agentId, /fail|error/i.test(e.type) ? 'failed' : 'completed');
    }
    j.offset += end;
  }
  return j;
}

async function readMeta(file) {
  const st = await fs.promises.stat(file);
  const c = metaCache.get(file);
  if (c && c.mtime === st.mtimeMs) return c;
  const next = { mtime: st.mtimeMs, meta: JSON.parse(await fs.promises.readFile(file, 'utf8')) };
  metaCache.set(file, next);
  return next;
}

async function startOf(file, st) {
  if (startCache.has(file)) return startCache.get(file);
  let at = 0;
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(st.size, 8192));
    await fh.read(buf, 0, buf.length, 0);
    const m = TS_RE.exec(buf.toString('utf8'));
    at = m ? Date.parse(m[1]) || 0 : 0;
  } finally {
    await fh.close();
  }
  at = at || st.birthtimeMs || st.mtimeMs;
  if (st.size >= 8192 || at) startCache.set(file, at);
  return at;
}

/**
 * Re-reads the subagents of the sessions the panel shows. `sessions` and `live` are extension.js's maps;
 * an agent can only be running while its session's Claude process is (and was started by that process).
 */
async function update(sessions, live, now = Date.now()) {
  if (requested.size) wanted = requested;
  requested = new Set();
  await Promise.all(
    [...wanted].map(async (id) => {
      const s = sessions.get(id);
      if (!s?.file) return bySession.delete(id);
      const l = live.get(id);
      const key = `${l ? l.startedAt || 1 : 0}:${s.mtime}`;
      const prev = bySession.get(id);
      // A session that isn't running can't change its agents without touching its transcript.
      if (prev && !l && prev.key === key) return;
      const dir = path.join(path.dirname(s.file), id, 'subagents');
      const ids = async (d) =>
        (await fs.promises.readdir(d).catch(() => [])).filter((n) => n.startsWith('agent-') && n.endsWith('.meta.json')).map((n) => n.slice(6, -10));
      const runs = new Map();
      const found = [{ d: dir, aids: await ids(dir) }];
      for (const run of (await fs.promises.readdir(path.join(dir, 'workflows')).catch(() => [])).filter((n) => /^wf_[\w-]+$/.test(n))) {
        const d = path.join(dir, 'workflows', run);
        const j = await readJournal(path.join(d, 'journal.jsonl')).catch(() => undefined);
        if (!j) continue;
        runs.set(run, j);
        found.push({ d, run, aids: await ids(d) });
      }
      const raw = (
        await Promise.all(
          found.flatMap(({ d, run, aids }) =>
            aids.map(async (aid) => {
              try {
                const { mtime: metaMtime, meta } = await readMeta(path.join(d, `agent-${aid}.meta.json`));
                const file = path.join(d, `agent-${aid}.jsonl`);
                const st = await fs.promises.stat(file);
                return { aid, run, meta, metaMtime, file, st, start: await startOf(file, st) };
              } catch {
                return undefined;
              }
            })
          )
        )
      ).filter(Boolean);

      // Completions of nested agents are in their parent agent's transcript.
      const parents = new Map();
      for (const a of raw) {
        const pid = a.meta.parentAgentId;
        const p = pid && !parents.has(pid) && raw.find((x) => x.aid === pid);
        if (p) parents.set(pid, await scanAgentFile(p.file, p.st.size).catch(() => ({})));
      }

      const agents = raw.map((a) => {
        const { meta, st } = a;
        // A nested agent's completion goes to its parent agent, or to the session once the parent has finished
        // (e.g. when it was resumed later): the latest of the two counts.
        // A workflow's agent returns to the workflow: its journal says so, without a time.
        const srcs = a.run ? [] : meta.parentAgentId ? [parents.get(meta.parentAgentId) || {}, s] : [s];
        const wfStatus = a.run && runs.get(a.run).done.get(a.aid);
        const note = wfStatus
          ? { at: st.mtimeMs, status: wfStatus }
          : srcs.map((x) => x.agentDone?.get(a.aid)).reduce((best, n) => (n && (!best || n.at > best.at) ? n : best), undefined);
        let doneAt = Math.max(note?.at || 0, ...srcs.map((x) => x.toolDone?.get(meta.toolUseId) || 0));
        let status = note && note.at >= doneAt ? note.status : doneAt ? 'completed' : '';
        if (meta.stoppedByUser && a.metaMtime > doneAt) {
          doneAt = a.metaMtime;
          status = 'stopped';
        }
        const resumed = doneAt && st.mtimeMs > doneAt + RESUME_SLACK;
        const alive = !!l && st.mtimeMs >= (l.startedAt || 0) - RESUME_SLACK;
        let state;
        if (alive && (!doneAt || resumed)) state = 'run';
        else if (doneAt) state = status === 'failed' ? 'failed' : status === 'completed' ? 'done' : 'stopped';
        else state = 'stopped'; // its Claude process is gone without telling anyone
        return {
          id: a.aid,
          desc: meta.description || meta.agentType || 'Agent',
          type: a.run ? '' : meta.agentType || '',
          depth: (meta.spawnDepth || 1) + (a.run ? 1 : 0),
          ...(a.run && { wf: a.run }),
          state,
          start: Math.round(a.start),
          // When it stopped: the completion, or its last transcript write if nothing reported it.
          end: state === 'run' ? 0 : Math.round(resumed || !doneAt ? st.mtimeMs : doneAt),
        };
      });
      // What the running ones are doing: from their own transcripts, appended bytes only.
      await Promise.all(
        agents.map(async (x, i) => {
          if (x.state !== 'run') return;
          const { st } = raw[i];
          const info = await scanAgentFile(raw[i].file, st.size).catch(() => undefined);
          // Ended on its final reply and quiet since: it's done, even if no completion notice was found.
          if (info?.act?.last === 'end' && now - st.mtimeMs > RESUME_SLACK) {
            Object.assign(x, { state: 'done', end: Math.round(st.mtimeMs) });
            return;
          }
          const line = activity.describe(info?.act, 'busy');
          // Running but silent for a while: say so, it may be stuck (or in one long command).
          const quiet = now - st.mtimeMs > QUIET ? `Quiet for ${ago(now - st.mtimeMs)}` : '';
          if (line || quiet) x.activity = [quiet, line].filter(Boolean).join(' · ');
        })
      );
      // One row per workflow run, its agents right under it.
      const flows = [...runs].map(([run, j]) => {
        const kids = agents.filter((x) => x.wf === run);
        const launch = s.workflows?.get(run);
        const note = launch && s.agentDone?.get(launch.task);
        const alive = !!l && j.mtime >= (l.startedAt || 0) - RESUME_SLACK;
        let state = 'stopped';
        if (note) state = note.status === 'failed' ? 'failed' : note.status === 'completed' ? 'done' : 'stopped';
        else if (alive || kids.some((x) => x.state === 'run')) state = 'run';
        return {
          id: run,
          desc: launch?.name || run,
          type: 'workflow',
          workflow: true,
          depth: 1,
          state,
          phase: j.phase,
          start: Math.round(Math.min(...kids.map((x) => x.start), j.mtime)),
          end: state === 'run' ? 0 : Math.round(note?.at || Math.max(j.mtime, ...kids.map((x) => x.end))),
        };
      });
      const latest = (a) => (a.state === 'run' ? Infinity : a.end);
      const order = (a, b) => latest(b) - latest(a) || b.start - a.start;
      const top = [...agents.filter((x) => !x.wf), ...flows].sort(order).slice(0, RECENT);
      const list = top.flatMap((x) => (x.workflow ? [x, ...agents.filter((k) => k.wf === x.id).sort(order)] : [x]));
      const files = new Map(raw.filter((a) => a.run).map((a) => [a.aid, a.file]));
      bySession.set(id, { dir, key, agents: list, files });
    })
  );
  for (const id of bySession.keys()) if (!wanted.has(id)) bySession.delete(id);
}

/** Compact list for the panel payload; also marks the session as shown, for the next update(). */
function get(id) {
  requested.add(id);
  return bySession.get(id)?.agents || [];
}

function transcript(sessionId, agentId) {
  const s = bySession.get(sessionId);
  if (!s || !/^[\w-]+$/.test(agentId)) return undefined;
  return s.files.get(agentId) || path.join(s.dir, `agent-${agentId}.jsonl`);
}

module.exports = { scanText, update, get, transcript };
