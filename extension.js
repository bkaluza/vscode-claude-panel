// Session Panel for Claude Code: a panel for Claude Code terminal sessions — what's running, what's done,
// open several at once in named, coloured terminals, and reopen them after a restart.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const usage = require('./usage');
const subagents = require('./subagents');
const transcripts = require('./transcripts');
const order = require('./order');
const activity = require('./activity');
const viewerPanel = require('./viewerPanel');
const colors = require('./colors');
const tally = require('./media/tally');
const names = require('./names');
const elsewhere = require('./elsewhere');
const desktop = require('./desktop');
const accountsOf = require('./accounts');
const results = require('./results');

// Each account's config directory (~/.claude, or $CLAUDE_CONFIG_DIR, unless claudeSessions.accounts lists several)
// has projects/ with the transcripts and sessions/, where Claude Code writes <pid>.json for every running session:
// { pid, sessionId, cwd, name, status, ... }
const projectsDir = (a) => path.join(a.dir, 'projects');
const liveDir = (a) => path.join(a.dir, 'sessions');
const SKIP_FLAG = '--dangerously-skip-permissions';
const POLL_MS = 2000;

const REMEMBERED_KEY = 'claudeSessions.open'; // workspaceState: ordered ids open in this window
const ORDER_KEY = 'claudeSessions.order'; // workspaceState: open sessions in the order you put them in
const PREFS_KEY = 'claudeSessions.prefs'; // globalState: { [id]: { pinned, hidden, alias, aliasWas, color, colorWas } }
const PIN_ORDER_KEY = 'claudeSessions.pinOrder'; // globalState: pinned ids in the order you put them in
const SLOT_KEYS_DECLINED_KEY = 'claudeSessions.slotKeysDeclined'; // globalState: "Not now" to commandsToSkipShell
const SPLIT_TIP_KEY = 'claudeSessions.splitTipShown'; // globalState: the split-layout tip was answered
const ACCOUNT_KEY = 'claudeSessions.account'; // workspaceState: config dir of the account last picked for a new session
const SLOT_COMMANDS = Array.from({ length: 9 }, (_, i) => `claudeSessions.focus${i + 1}`);
const PANEL_COMMANDS = ['claudeSessions.showPanel', 'claudeSessions.resume', 'claudeSessions.new'];
const MOD_KEY = process.platform === 'darwin' ? 'Cmd' : 'Ctrl';

// Claude Code's /color names → our theme colours (package.json "colors"), which default to Claude Code's own values.
const COLORS = Object.fromEntries(
  ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink'].map((c) => [c, `claudeSessions.${c}`])
);

let context;
let view;
let statusItem;

/** id → session info, from the last scan */
let sessions = new Map();
/** id → transcript file of a live session that isn't in the workspace's project folders (started elsewhere) */
const elsewhereFiles = new Map();
/** { label, dir, command, color } per account, from claudeSessions.accounts; one unlabelled one when it's empty */
let accounts = [];
/** id → live record (from an account's sessions/) plus its `account` dir, and `terminal` when it runs in one of this window's terminals */
let live = new Map();
/** terminal → session id (or undefined for a new session), for terminals Claude hasn't registered yet */
const pending = new Map();
/** terminal → colour chosen for a new session, applied once its id is known */
const pendingColor = new Map();
/** terminal → { id, name }: a /rename for the session in it, sent once it's idle (and only if it's still that one) */
const pendingName = new Map();
/** terminals whose session goes to the Claude desktop app (/desktop) once it's idle */
const pendingDesktop = new Set();
/** terminal → session id it sent there: the terminal closes once the app runs the session */
const handedOff = new Map();
/** terminal → session id last seen running in it */
const termSession = new Map();
/** terminal → consecutive polls with no Claude running in it */
const termMisses = new Map();
/** child session id → { parentCliId, kind }, from the Claude desktop app's metadata; and parent → its children */
let lineage = new Map();
let childrenOf = new Map();
const readDesktop = desktop.reader();
/** ids that finished working while you weren't looking at them */
const unread = new Set();
let polling = false;
let lastPayload = '';
/** every transcript the last scan read, and what the live records looked like: for formatNotice */
let scanned = [];
let liveFormat = {};
/** consecutive polls on which Claude Code's files didn't look as expected, and the notice once that has held */
let formatMisses = 0;
let formatNotice = '';
let slotKeysAsked = false;
let usedEditor = false; // an editor was used since the active terminal last changed (see watching())
/** while syncTabs moves terminal tabs, and the session tabs as last seen: so only your own tab drags count */
let movingTabs = false;
let lastTabs = [];
let tabSync = Promise.resolve();

const cfg = () => vscode.workspace.getConfiguration('claudeSessions');
const prefs = () => context.globalState.get(PREFS_KEY, {});
const remembered = () => context.workspaceState.get(REMEMBERED_KEY, []);
const manualOrder = () => context.workspaceState.get(ORDER_KEY, []);

function setPref(id, patch) {
  const all = prefs();
  const p = { ...all[id], ...patch };
  for (const k of Object.keys(p)) if (p[k] === undefined || p[k] === false || p[k] === '') delete p[k];
  if (Object.keys(p).length) all[id] = p;
  else delete all[id];
  return context.globalState.update(PREFS_KEY, all).then(refresh);
}

function loadAccounts() {
  accounts = accountsOf.resolve(cfg().get('accounts'), { command: cfg().get('command') });
}

// Badges and the account pick only once there is a choice.
const severalAccounts = () => accounts.length > 1;

// The account a session runs on: its live record says, else the folder its transcript is in.
function accountOf(id) {
  const dir = live.get(id)?.account;
  return accounts.find((a) => a.dir === dir) || accountsOf.ofFile(accounts, sessions.get(id)?.file) || accounts[0];
}

function setRemembered(ids) {
  return context.workspaceState.update(REMEMBERED_KEY, [...new Set(ids)]);
}

// Pinned ids in the order you put them in, newly pinned last. Pins from before there was an order: newest first.
function pinOrder() {
  const all = prefs();
  const mtime = (id) => sessions.get(id)?.mtime || 0;
  const pinned = Object.keys(all).filter((id) => all[id].pinned).sort((a, b) => mtime(b) - mtime(a));
  return order.arrange(context.globalState.get(PIN_ORDER_KEY, []), pinned);
}

async function setPinned(id, on) {
  const ids = pinOrder().filter((x) => x !== id);
  await context.globalState.update(PIN_ORDER_KEY, on ? [...ids, id] : ids);
  return setPref(id, { pinned: on });
}

// Stores the open sessions' order. Remembered sessions not reopened yet keep their place among them.
function setOpenOrder(ids) {
  const stored = manualOrder();
  const rem = remembered();
  const all = order.arrange(stored, [...stored.filter((id) => rem.includes(id)), ...ids]);
  return context.workspaceState.update(ORDER_KEY, order.refill(all, ids));
}

// ---------------------------------------------------------------- session files

async function projectDirs() {
  const sub = cfg().get('includeSubfolders');
  // Windows paths ignore case: fsPath lowercases the drive letter, while Claude Code keeps the cwd's casing, and
  // the folder keeps whichever casing created it first.
  const fold = process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;
  const dirs = new Set();
  for (const a of accounts) {
    const entries = await fs.promises.readdir(projectsDir(a), { withFileTypes: true }).catch(() => []);
    for (const f of vscode.workspace.workspaceFolders || []) {
      const enc = fold(transcripts.encodeCwd(f.uri.fsPath));
      for (const e of entries) {
        const name = fold(e.name);
        if (e.isDirectory() && (name === enc || (sub && name.startsWith(enc + '-')))) {
          dirs.add(path.join(projectsDir(a), e.name));
        }
      }
    }
  }
  return [...dirs];
}

async function scan() {
  const files = [];
  for (const dir of await projectDirs()) {
    for (const f of await fs.promises.readdir(dir).catch(() => [])) {
      if (f.endsWith('.jsonl')) files.push(path.join(dir, f));
    }
  }
  const infos = await Promise.all(files.map((f) => transcripts.readSession(f).catch(() => undefined)));
  scanned = infos.filter(Boolean);
  sessions = new Map(scanned.filter((s) => s.hasMessages).map((s) => [s.id, s]));
  await scanElsewhere();
}

// Live sessions started in another folder have their transcript in that folder's project folder: read those
// too, so their cards, read-only views, subagents and resume (which needs their cwd) work like the others.
async function scanElsewhere() {
  for (const id of elsewhereFiles.keys()) if (!live.has(id) || sessions.has(id)) elsewhereFiles.delete(id);
  for (const [id, l] of live) {
    if (sessions.has(id)) continue;
    const file = await transcriptOf(id, l.cwd);
    const info = file && (await transcripts.readSession(file).catch(() => undefined));
    if (info?.hasMessages) sessions.set(id, info);
  }
}

// Cached once found: a transcript stays where it was first written. The session's own account is searched first.
async function transcriptOf(id, cwd) {
  const known = elsewhereFiles.get(id);
  if (known && fs.existsSync(known)) return known;
  const own = live.get(id)?.account;
  let file;
  for (const a of [...accounts].sort((x, y) => (y.dir === own) - (x.dir === own))) {
    if ((file = await transcripts.findTranscript(projectsDir(a), id, cwd))) break;
  }
  if (file) elsewhereFiles.set(id, file);
  else elsewhereFiles.delete(id);
  return file;
}

// ---------------------------------------------------------------- live sessions

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function readLive() {
  const out = [];
  const format = { parsed: 0, ok: 0, version: '' };
  for (const a of accounts) {
    for (const f of await fs.promises.readdir(liveDir(a)).catch(() => [])) {
      if (!f.endsWith('.json')) continue;
      try {
        const d = JSON.parse(await fs.promises.readFile(path.join(liveDir(a), f), 'utf8'));
        format.parsed++;
        if (transcripts.isLiveRecord(d)) format.ok++;
        if (typeof d.version === 'string') format.version ||= d.version;
        if (d.sessionId && d.pid && alive(d.pid)) out.push({ ...d, account: a.dir });
      } catch {}
    }
  }
  liveFormat = format;
  return out;
}

// Windows has no ps; CIM has the same pid → parent table, but takes a couple of seconds to ask.
const PS =
  process.platform === 'win32'
    ? [
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }",
        ],
      ]
    : ['ps', ['-A', '-o', 'pid=,ppid=']];

// A process's parent never changes, so where listing them is slow the map is only rebuilt when a claude
// process turns up that it hasn't seen (keyed by start time too, in case a pid is reused).
let parentCache = { map: new Map(), seen: new Set() };

async function parentPids(records) {
  if (process.platform !== 'win32') return listParents();
  const keys = records.map((d) => `${d.pid}:${d.startedAt}`);
  if (keys.some((k) => !parentCache.seen.has(k))) {
    const map = await listParents();
    parentCache = { map, seen: map.size ? new Set(keys) : new Set() };
  }
  return parentCache.map;
}

function listParents() {
  return new Promise((resolve) => {
    execFile(PS[0], PS[1], { windowsHide: true }, (err, stdout) => {
      const map = new Map();
      if (!err) {
        for (const line of stdout.split('\n')) {
          const [pid, ppid] = line.trim().split(/\s+/).map(Number);
          if (pid) map.set(pid, ppid);
        }
      }
      resolve(map);
    });
  });
}

async function pollLive() {
  const records = await readLive();
  const parents = records.length ? await parentPids(records) : new Map();
  const shells = new Map();
  await Promise.all(
    vscode.window.terminals.map(async (t) => {
      const pid = await t.processId;
      if (pid) shells.set(pid, t);
    })
  );

  const next = new Map();
  for (const d of records) {
    let terminal;
    // Walk up from the claude process to the shell of one of this window's terminals.
    for (let p = parents.get(d.pid), i = 0; p > 1 && i < 6; p = parents.get(p), i++) {
      if (shells.has(p)) {
        terminal = shells.get(p);
        break;
      }
    }
    next.set(d.sessionId, { ...d, terminal });
  }

  // Terminals we just started, before Claude has registered them.
  const running = new Set([...next.values()].map((e) => e.terminal).filter(Boolean));
  for (const [t, id] of pending) {
    if (!vscode.window.terminals.includes(t) || running.has(t)) pending.delete(t);
    else if (id && !next.has(id)) next.set(id, { sessionId: id, status: 'starting', terminal: t });
  }

  // Finished, or needs you, while you were looking elsewhere? Claude reports busy → idle when a turn
  // ends, and 'waiting' (with waitingFor, e.g. "permission prompt") when it's blocked on you.
  for (const [id, e] of next) {
    const before = live.get(id)?.status;
    if (!before || before === e.status || !e.terminal) continue;
    if (watching(e.terminal)) continue;
    const show = (c) => c && e.terminal.show();
    if (e.status === 'waiting') {
      if (cfg().get('notifyWhenDone')) {
        const why = e.waitingFor ? `: ${e.waitingFor}` : '';
        vscode.window.showWarningMessage(`${titleOf(id)} needs you${why}.`, 'Show').then(show);
      }
    } else if (before === 'busy' && e.status === 'idle') {
      unread.add(id);
      if (cfg().get('notifyWhenDone')) vscode.window.showInformationMessage(`${titleOf(id)} is done.`, 'Show').then(show);
    }
  }
  live = next;
  for (const id of unread) if (!live.get(id)?.terminal) unread.delete(id);
  trackRemembered();
}

// Keeps the list of sessions open in this window, for reopening after a restart. A session leaves the
// list only when you close its terminal or exit Claude in it — not when the window shuts down.
function trackRemembered() {
  const ids = remembered();
  const add = [];
  const seen = new Set();
  for (const [id, e] of live) {
    if (!e.terminal) continue;
    seen.add(e.terminal);
    termSession.set(e.terminal, id);
    termMisses.delete(e.terminal);
    if (!ids.includes(id)) add.push(id);
    if (e.status !== 'idle') continue; // never into a turn in progress, or a prompt waiting for you
    const commands = [];
    // There's no command-line option for the colour, so a new session gets /color once Claude is at its prompt.
    const color = pendingColor.get(e.terminal);
    if (color) {
      pendingColor.delete(e.terminal);
      if (!sessions.get(id)?.color) setPref(id, { color });
      commands.push(`/color ${color}`);
    }
    // A name from Rename…, unless the session in the terminal is another one by now or already has that name.
    const rename = pendingName.get(e.terminal);
    if (rename) {
      pendingName.delete(e.terminal);
      const has = [names.fromClaude(sessions.get(id)), e.nameSource === 'user' ? names.clean(e.name) : ''];
      if (rename.id === id && rename.name && !has.includes(rename.name)) commands.push(`/rename ${rename.name}`);
    }
    // Last: /desktop ends the session here.
    if (pendingDesktop.delete(e.terminal)) {
      commands.push('/desktop');
      handedOff.set(e.terminal, id);
    }
    commands.forEach((c, i) => {
      setTimeout(() => e.terminal.sendText(c, false), i * 500);
      setTimeout(() => e.terminal.sendText('\r', false), i * 500 + 150);
    });
  }
  const drop = [];
  for (const [t, id] of termSession) {
    if (seen.has(t) || pending.has(t)) continue;
    const misses = (termMisses.get(t) || 0) + 1;
    termMisses.set(t, misses);
    if (misses >= 3) {
      termSession.delete(t);
      termMisses.delete(t);
      if (vscode.window.terminals.includes(t)) drop.push(id); // Claude exited, terminal still there
    }
  }
  if (add.length || drop.length) setRemembered([...ids.filter((id) => !drop.includes(id)), ...add]);
  // Not before the app runs the session: if /desktop failed, its terminal shows why.
  for (const [t, id] of handedOff) {
    const l = live.get(id);
    if (!l || l.terminal || elsewhere.where(l) !== 'app') continue;
    handedOff.delete(t);
    t.dispose();
  }
}

// ---------------------------------------------------------------- terminals

function titleOf(id) {
  return transcripts.pickTitle(id, { alias: prefs()[id]?.alias, session: sessions.get(id), live: live.get(id) });
}

const colorOf = (id) => colors.shown(prefs()[id], sessions.get(id)?.color);

// Forget a pick Claude Code has moved on from, so a later /color back to the old colour doesn't bring it back.
async function dropSupersededColors() {
  for (const [id, p] of Object.entries(prefs())) {
    const s = sessions.get(id);
    if (s && colors.superseded(p, s.color)) await setPref(id, { color: undefined, colorWas: undefined });
  }
}

// The same for names: once Claude Code has a newer name (/rename typed in the terminal, or ours arrived), it's the
// session's name and the panel's alias goes, along with any /rename still waiting to be sent for it. An alias from
// before this has no aliasWas: it goes if Claude Code has the same name, else Claude Code's name now is noted, so
// only a later change counts.
async function dropSupersededNames() {
  for (const [id, p] of Object.entries(prefs())) {
    const s = sessions.get(id);
    if (!s || !p.alias) continue;
    const claude = names.fromClaude(s);
    if (p.aliasWas === undefined && !names.superseded(p, claude)) {
      await setPref(id, { aliasWas: claude ?? null });
      continue;
    }
    if (!names.superseded(p, claude)) continue;
    for (const [t, r] of pendingName) if (r.id === id) pendingName.delete(t);
    await setPref(id, { alias: undefined, aliasWas: undefined });
  }
}

function quote(a) {
  return /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

function launchArgs(base, skip = cfg().get('skipPermissions'), account = accounts[0]) {
  const extra = cfg().get('extraArgs').filter((a) => a !== SKIP_FLAG);
  return [account.command, ...base, ...(skip ? [SKIP_FLAG] : []), ...extra].map(quote).join(' ');
}

function createTerminal(name, color, cwd, account = accounts[0]) {
  const env = accountsOf.terminalEnv(account);
  return vscode.window.createTerminal({
    name,
    cwd: cwd && fs.existsSync(cwd) ? cwd : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    color: new vscode.ThemeColor(COLORS[color] || 'terminal.ansiWhite'),
    iconPath: new vscode.ThemeIcon('sparkle'),
    location: terminalLocation(),
    ...(env ? { env } : {}), // the account's config dir, for the command and everything Claude Code runs
    // Not transient: VS Code keeps these running across window reloads. After a full restart it revives
    // them as empty shells, which resume() reuses by name.
  });
}

// In 'split' mode session terminals live in the second editor group, files in the first.
const TERMINAL_COLUMN = vscode.ViewColumn.Two;
const splitMode = () => cfg().get('terminalLocation') === 'split';

function terminalLocation() {
  switch (cfg().get('terminalLocation')) {
    case 'panel':
      return vscode.TerminalLocation.Panel;
    case 'editor':
      return vscode.TerminalLocation.Editor;
    default:
      return { viewColumn: TERMINAL_COLUMN };
  }
}

const isTerminalTab = (tab) => tab.input instanceof vscode.TabInputTerminal;

// A file opened while a session terminal has focus would land among the terminals; send it left.
function keepFilesLeft(e) {
  if (!splitMode()) return;
  for (const tab of e.opened) {
    const g = tab.group;
    if (g.viewColumn !== TERMINAL_COLUMN || isTerminalTab(tab) || !tab.isActive || !g.isActive) continue;
    if (!g.tabs.some(isTerminalTab)) continue; // the user is using the second group for files
    vscode.commands.executeCommand('workbench.action.moveEditorToFirstGroup');
  }
}

function idsByName() {
  const byName = new Map();
  for (const [id, e] of live) if (e.terminal) byName.set(e.terminal.name, id);
  return byName;
}

// A group's tabs as session ids, null for anything that isn't a session's terminal.
const groupTabIds = (g, byName = idsByName()) => g.tabs.map((tab) => (isTerminalTab(tab) && byName.get(tab.label)) || null);

// Sessions with an editor tab, left to right across the editor groups.
function tabSessions() {
  const byName = idsByName();
  return vscode.window.tabGroups.all.flatMap((g) => groupTabIds(g, byName)).filter(Boolean);
}

// The order of the open sessions in the panel and for ⌘1…⌘9: the order you put them in (dragged in the panel,
// Move up / down, or by moving their terminal tabs), then any not in it yet: Claude terminal tabs left to right as they
// sit in the editor groups, then those in the terminal panel in the order they were opened.
function sessionOrder() {
  const ids = [];
  const add = (id) => id && live.get(id)?.terminal && !ids.includes(id) && ids.push(id);
  tabSessions().forEach(add);
  remembered().forEach(add);
  [...live.keys()].forEach(add);
  return order.arrange(manualOrder(), ids);
}

// A section of the panel in a new order. `ids` are the section's sessions as the panel shows them, so maybe only
// the ones a filter left; the rest keep their places.
async function reorder(section, ids) {
  if (section === 'pinned') {
    await context.globalState.update(PIN_ORDER_KEY, order.refill(pinOrder(), ids));
    return refresh();
  }
  if (section !== 'open') return;
  await setOpenOrder(order.refill(sessionOrder(), ids));
  refresh();
  return (tabSync = tabSync.then(syncTabs, syncTabs));
}

// The panel section a session is in and its sessions in order, for Move up / down. One running elsewhere that has
// been idle past the cut-off is listed with the others, so it can be in Pinned too.
function sectionOf(id) {
  if (live.get(id)?.terminal) return ['open', sessionOrder()];
  const all = prefs();
  const listed = (x) => !live.get(x)?.terminal && !activeElsewhere(x);
  if (!all[id]?.pinned || !listed(id)) return [];
  return ['pinned', pinOrder().filter((x) => x === id || (sessions.has(x) && listed(x) && !all[x].hidden))];
}

const ORDINALS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'];
const tabKey = (tab) => tab?.input?.uri?.toString() || tab?.label;

async function until(ok, ms = 1000) {
  for (let t = 0; t < ms && !ok(); t += 25) await new Promise((r) => setTimeout(r, 25));
  return ok();
}

// Puts the session terminals' editor tabs in the open order, group by group, moving only session tabs. VS Code
// moves the active editor, so each terminal is shown first; afterwards every group gets its active tab back and
// focus returns to the editor group and then the panel. Terminals in the terminal panel have no API for their
// order and stay as they are.
async function syncTabs() {
  const want = sessionOrder();
  const startGroup = vscode.window.tabGroups.activeTabGroup.viewColumn;
  const startTerminal = vscode.window.activeTerminal;
  const keepUnread = new Set(unread);
  let moved = false;
  movingTabs = true;
  try {
    for (const column of vscode.window.tabGroups.all.map((g) => g.viewColumn)) {
      const group = () => vscode.window.tabGroups.all.find((g) => g.viewColumn === column);
      const active = tabKey(group()?.activeTab);
      let touched = false;
      for (const [id, to] of order.tabMoves(groupTabIds(group()), want)) {
        const t = live.get(id)?.terminal;
        if (!t) break;
        t.show();
        const front = () => {
          const g = vscode.window.tabGroups.activeTabGroup;
          return g.viewColumn === column && isTerminalTab(g.activeTab || {}) && g.activeTab.label === t.name;
        };
        if (!(await until(front))) break;
        await vscode.commands.executeCommand('moveActiveEditor', { to: 'position', by: 'tab', value: to + 1 });
        touched = moved = true;
      }
      const i = touched ? group().tabs.findIndex((tab) => tabKey(tab) === active) : -1;
      if (i >= 0) await vscode.commands.executeCommand('workbench.action.openEditorAtIndex', i);
    }
  } finally {
    if (moved) {
      const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((x) => isTerminalTab(x) && x.label === startTerminal?.name);
      if (tab?.isActive) startTerminal.show(true); // the current session stays current
      const nth = ORDINALS[startGroup - 1];
      if (nth) await vscode.commands.executeCommand(`workbench.action.focus${nth}EditorGroup`);
      await vscode.commands.executeCommand('claudeSessions.panel.focus');
    }
    for (const id of keepUnread) if (live.get(id)?.terminal) unread.add(id); // showing a terminal isn't reading it
    lastTabs = tabSessions();
    movingTabs = false;
    refresh();
  }
}

// You moved a session's terminal tab yourself: the open order follows the tabs. Until there is a manual order the
// tab order is used anyway; our own moves don't count.
function followTabs() {
  if (movingTabs) return;
  const now = tabSessions();
  const before = lastTabs;
  lastTabs = now;
  if (!manualOrder().length || !order.reordered(before, now)) return;
  setOpenOrder(order.refill(sessionOrder(), now)).then(refresh);
}

function focusSlot(n) {
  const id = sessionOrder()[n - 1];
  if (id) resume(id);
}

const slotKeysOn = () => cfg().get('sessionShortcuts') !== false;

// Keybindings for extension commands are sent to the shell while a terminal has focus, unless the
// command is listed in terminal.integrated.commandsToSkipShell. That's the user's setting, so we ask first.
const terminalCommands = (slotKeys = slotKeysOn()) => [...PANEL_COMMANDS, ...(slotKeys ? SLOT_COMMANDS : [])];

function slotKeysMissing() {
  const list = vscode.workspace.getConfiguration('terminal.integrated').get('commandsToSkipShell') || [];
  return terminalCommands().filter((c) => !list.includes(c));
}

function letSlotKeysThroughTerminal(slotKeys) {
  const conf = vscode.workspace.getConfiguration('terminal.integrated');
  const list = conf.inspect('commandsToSkipShell')?.globalValue || [];
  const missing = terminalCommands(slotKeys).filter((c) => !list.includes(c));
  return missing.length && conf.update('commandsToSkipShell', [...list, ...missing], vscode.ConfigurationTarget.Global);
}

// Once per window, and never again after "Not now" (the command does it later).
async function offerSlotKeysInTerminal() {
  if (slotKeysAsked || context.globalState.get(SLOT_KEYS_DECLINED_KEY) || !slotKeysMissing().length) return;
  slotKeysAsked = true;
  const slots = slotKeysOn() ? `, ${MOD_KEY}+1–9` : '';
  const choice = await vscode.window.showInformationMessage(
    `Session Panel: ${MOD_KEY}+Alt+C, R, N${slots} don't work while a terminal has focus. To fix that, ` +
      'add their commands to your terminal.integrated.commandsToSkipShell setting?',
    'Allow',
    'Not now'
  );
  if (choice === 'Allow') await letSlotKeysThroughTerminal();
  else if (choice === 'Not now') await context.globalState.update(SLOT_KEYS_DECLINED_KEY, true);
}

async function enableSlotKeysInTerminal() {
  await letSlotKeysThroughTerminal(true);
  if (!slotKeysOn()) await cfg().update('sessionShortcuts', true, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`The panel's keys, ${MOD_KEY}+1–9 included, now work from terminals too.`);
}

// Moves the Claude terminals of this window into the right-hand editor group.
async function moveSessionsToSplit() {
  for (const e of [...live.values()]) {
    const t = e.terminal;
    if (!t) continue;
    t.show();
    await vscode.commands.executeCommand('workbench.action.terminal.moveToEditor');
    const g = vscode.window.tabGroups.activeTabGroup;
    if (isTerminalTab(g.activeTab || {}) && g.activeTab.label === t.name && g.viewColumn !== TERMINAL_COLUMN) {
      await vscode.commands.executeCommand('workbench.action.moveEditorToSecondGroup');
    }
  }
}

// A terminal VS Code revived after a restart, with this session's name and nothing running in it, set up for the
// same account.
function idleTerminalNamed(name, account = accounts[0]) {
  const busy = new Set([...live.values()].map((e) => e.terminal).filter(Boolean));
  const env = accountsOf.terminalEnv(account);
  return vscode.window.terminals.find(
    (t) =>
      t.name.toLowerCase() === name.toLowerCase() &&
      !busy.has(t) &&
      !pending.has(t) &&
      !t.exitStatus &&
      accountsOf.sameEnv(t.creationOptions?.env, env)
  );
}

async function resume(id, { skip, fork, preserveFocus } = {}) {
  const e = live.get(id);
  if (e?.terminal && !fork) {
    e.terminal.show(preserveFocus);
    unread.delete(id);
    return refresh();
  }
  if (e && !e.terminal && !fork) {
    const view = 'View read-only';
    const copy = 'Continue in a copy';
    const choice = await vscode.window.showWarningMessage(
      `"${titleOf(id)}" is running in another window or terminal.`,
      {
        modal: true,
        detail:
          `${view} follows it live without touching it.\n\n` +
          `${copy} starts a new session here from its history; the original keeps running on its own.\n\n` +
          'Open here too resumes the same session a second time. Both would then add to one conversation and drift ' +
          'apart, so only do this if the other one has stopped.',
      },
      view,
      copy,
      'Open here too'
    );
    if (!choice) return;
    if (choice === view) return openView(id);
    fork = choice === copy;
  }
  const s = sessions.get(id) || {};
  const title = titleOf(id);
  const alias = names.clean(prefs()[id]?.alias);
  const account = accountOf(id); // a fork stays on its session's account too
  const base = ['--resume', id, ...(fork ? ['--fork-session'] : []), ...(alias ? ['-n', alias] : [])];
  const t =
    (!fork && idleTerminalNamed(title, account)) ||
    createTerminal(fork ? `${title} (fork)` : title, colorOf(id), s.cwd || e?.cwd, account);
  t.sendText(launchArgs(base, skip, account));
  const color = !fork && colors.toSend(prefs()[id], s.color);
  if (color) pendingColor.set(t, color);
  // -n names it for this run; /rename, once it's at its prompt, makes that Claude Code's own name for the session.
  const rename = !fork && names.toSend(prefs()[id], names.fromClaude(s));
  if (rename) pendingName.set(t, { id, name: rename });
  t.show(preserveFocus);
  pending.set(t, fork ? undefined : id);
  if (!fork) {
    const ids = remembered();
    if (!ids.includes(id)) await setRemembered([...ids, id]);
  }
  refresh();
}

async function resumeMany(ids, opts) {
  for (const id of ids) await resume(id, { ...opts, preserveFocus: true });
}

async function newSession() {
  const account = await pickAccount();
  if (!account) return;
  const name = await vscode.window.showInputBox({ title: 'New Claude session', prompt: 'Session name (optional)' });
  if (name === undefined) return;
  const color = await pickColor('Terminal colour');
  if (color === undefined) return;
  const t = createTerminal(name || 'claude', color, undefined, account);
  t.sendText(launchArgs(name ? ['-n', name] : [], undefined, account));
  t.show();
  pending.set(t, undefined);
  if (color) pendingColor.set(t, color);
  refresh();
}

// With several accounts, which one the new session runs on: the one last picked in this workspace comes first.
async function pickAccount() {
  if (!severalAccounts()) return accounts[0];
  const last = context.workspaceState.get(ACCOUNT_KEY);
  const items = accounts.map((a) => ({
    label: a.label,
    description: accountsOf.display(a.dir),
    detail: a.command,
    iconPath: new vscode.ThemeIcon('account', a.color ? new vscode.ThemeColor(COLORS[a.color]) : undefined),
    account: a,
  }));
  const qp = vscode.window.createQuickPick();
  Object.assign(qp, { items, title: 'New Claude session: account', matchOnDescription: true });
  qp.activeItems = [items.find((i) => i.account.dir === last) || items[0]];
  const pick = await new Promise((done) => {
    qp.onDidAccept(() => done(qp.activeItems[0]));
    qp.onDidHide(() => done(undefined));
    qp.show();
  });
  qp.dispose();
  if (pick) await context.workspaceState.update(ACCOUNT_KEY, pick.account.dir);
  return pick?.account;
}

async function pickColor(title) {
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'none', color: '' },
      ...Object.keys(COLORS).map((c) => ({
        label: c,
        color: c,
        iconPath: new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(COLORS[c])),
      })),
    ],
    { title }
  );
  return pick?.color;
}

async function moreActions(id) {
  const p = prefs()[id] || {};
  const s = sessions.get(id) || {};
  const skip = cfg().get('skipPermissions');
  const items = [
    { label: '$(edit) Rename…', run: renameSession },
    { label: '$(symbol-color) Colour…', run: recolorSession },
    { label: p.pinned ? '$(pinned) Unpin' : '$(pin) Pin', run: () => setPinned(id, !p.pinned) },
    { label: p.hidden ? '$(eye) Unhide' : '$(eye-closed) Hide', run: () => setPref(id, { hidden: !p.hidden }) },
    ...moveItems(id),
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    {
      label: skip ? '$(shield) Resume asking for permissions' : '$(warning) Resume skipping permissions',
      run: () => resume(id, { skip: !skip }),
    },
    { label: '$(repo-forked) Fork into a new session', run: () => resume(id, { fork: true }) },
    ...(live.get(id) && !live.get(id).terminal ? [{ label: '$(play) Open here as well…', run: () => resume(id) }] : []),
    ...(live.get(id)?.terminal ? [{ label: '$(close) Close session', run: closeSession }] : []),
    // No Claude desktop app on Linux.
    ...(live.get(id)?.terminal && process.platform !== 'linux'
      ? [{ label: '$(device-desktop) Resume in Claude Desktop', run: resumeInDesktop }]
      : []),
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(eye) Open read-only view', run: openView },
    {
      label: '$(go-to-file) Open transcript file',
      run: () => s.file && vscode.window.showTextDocument(vscode.Uri.file(s.file)),
    },
    { label: '$(copy) Copy session id', run: () => vscode.env.clipboard.writeText(id) },
    {
      label: '$(copy) Copy resume command',
      // claude --resume only finds a session from the folder it was started in, and with its account's config dir.
      run: () => {
        const account = accountOf(id);
        const dir = accountsOf.terminalEnv(account)?.CLAUDE_CONFIG_DIR;
        const env = dir ? `CLAUDE_CONFIG_DIR=${quote(dir)} ` : '';
        const cd = s.cwd ? `cd ${quote(s.cwd)} && ` : '';
        return vscode.env.clipboard.writeText(cd + env + launchArgs(['--resume', id], undefined, account));
      },
    },
  ];
  const pick = await vscode.window.showQuickPick(items, { title: titleOf(id) });
  return pick?.run?.(id);
}

// Closes the session's terminal, which ends Claude Code there; the session can be resumed later.
async function closeSession(id) {
  const e = live.get(id);
  if (!e?.terminal) return;
  if (e.status === 'busy' || e.status === 'waiting') {
    const ok = await vscode.window.showWarningMessage(
      `"${titleOf(id)}" is ${e.status === 'busy' ? 'still working' : 'waiting for you'}. Close it anyway?`,
      { modal: true },
      'Close'
    );
    if (ok !== 'Close') return;
  }
  e.terminal.dispose();
}

// Hands the session to the Claude desktop app with /desktop once it's idle; Claude Code ends it here.
function resumeInDesktop(id) {
  const t = live.get(id)?.terminal;
  if (t) pendingDesktop.add(t);
}

// Move up / down within the session's section, where it has somewhere to go.
function moveItems(id) {
  const [section, ids] = sectionOf(id);
  const i = ids ? ids.indexOf(id) : -1;
  const item = (label, by) => ({ label, run: () => reorder(section, order.move(ids, id, by)) });
  return [
    ...(i > 0 ? [item('$(arrow-up) Move up', -1)] : []),
    ...(i >= 0 && i < ids.length - 1 ? [item('$(arrow-down) Move down', 1)] : []),
  ];
}

// Claude Code gets the name as /rename: here once the session is idle, otherwise when it's next resumed from the
// panel. An empty name only drops the panel's: Claude Code has no command to clear its own, so that one stays.
async function renameSession(id) {
  const input = await vscode.window.showInputBox({
    title: 'Rename session',
    value: titleOf(id),
    prompt: 'Shown in the panel and terminal tab, and given to Claude Code as /rename. Empty: back to Claude Code’s own name.',
  });
  if (input === undefined) return;
  const name = names.clean(input);
  const t = live.get(id)?.terminal;
  for (const [x, r] of pendingName) if (r.id === id) pendingName.delete(x);
  if (!name) return setPref(id, { alias: undefined, aliasWas: undefined });
  const claude = names.fromClaude(sessions.get(id));
  if (t && name !== claude) pendingName.set(t, { id, name });
  return setPref(id, { alias: name, aliasWas: claude ?? null });
}

async function recolorSession(id) {
  const color = await pickColor('Session colour');
  if (color === undefined) return;
  const pick = color || 'default';
  // Claude Code gets it as /color: here once the session is idle, otherwise when it's next resumed from the panel.
  const t = live.get(id)?.terminal;
  if (t) pendingColor.set(t, pick);
  return setPref(id, { color: pick, colorWas: colors.fromClaude(sessions.get(id)?.color) });
}

const notReopened = () => order.arrange(manualOrder(), remembered()).filter((id) => !live.get(id)?.terminal && sessions.has(id));

async function restoreLast() {
  const ids = notReopened();
  if (!ids.length) return vscode.window.showInformationMessage('No Claude sessions to reopen.');
  await resumeMany(ids);
}

async function restoreOnStartup() {
  const mode = cfg().get('restoreOnStartup');
  const ids = notReopened();
  if (mode === 'never' || !ids.length) return;
  if (mode === 'ask') {
    const yes = `Reopen ${ids.length}`;
    const names = ids.slice(0, 4).map(titleOf).join(', ') + (ids.length > 4 ? ', …' : '');
    const choice = await vscode.window.showInformationMessage(
      `Reopen the Claude sessions that were open last time? (${names})`,
      yes,
      'Choose in panel'
    );
    if (choice === 'Choose in panel') return vscode.commands.executeCommand('claudeSessions.panel.focus');
    if (choice !== yes) return;
  }
  return resumeMany(ids);
}

function ago(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

async function quickPickResume() {
  const items = [...sessions.values()]
    .filter((s) => !prefs()[s.id]?.hidden)
    .sort((a, b) => b.mtime - a.mtime)
    .map((s) => ({
      label: `${live.get(s.id)?.terminal ? '$(terminal) ' : ''}${titleOf(s.id)}`,
      description: [accountLabel(s.id), colorOf(s.id), ago(s.mtime), s.cwd && path.basename(s.cwd)].filter(Boolean).join(' · '),
      detail: s.lastPrompt && s.lastPrompt !== titleOf(s.id) ? s.lastPrompt : undefined,
      iconPath: new vscode.ThemeIcon(
        'circle-filled',
        new vscode.ThemeColor(COLORS[colorOf(s.id)] || 'disabledForeground')
      ),
      id: s.id,
    }));
  const qp = vscode.window.createQuickPick();
  Object.assign(qp, { items, canSelectMany: true, matchOnDescription: true, matchOnDetail: true });
  qp.title = 'Resume Claude sessions';
  qp.activeItems = items.slice(0, 1);
  // Enter with nothing ticked resumes the highlighted session; a multi-select list would return nothing.
  const picked = await new Promise((done) => {
    qp.onDidAccept(() => done(qp.selectedItems.length ? qp.selectedItems : qp.activeItems));
    qp.onDidHide(() => done([]));
    qp.show();
  });
  qp.dispose();
  if (picked.length) await resumeMany(picked.map((p) => p.id));
}

// ---------------------------------------------------------------- read-only views

// A session running elsewhere may have started since the last poll: its transcript is looked up then.
async function openView(id) {
  const file = sessions.get(id)?.file || (live.has(id) && (await transcriptOf(id, live.get(id).cwd)));
  if (file) return viewerPanel.open({ file, kind: 'session', sessionId: id, title: titleOf(id) });
  vscode.window.showInformationMessage(`"${titleOf(id)}" has no transcript yet; it's written once the session has a first message.`);
}

// `file` when the view of another transcript asked (viewer.agentFile checked it); else from the panel's list.
function openAgentView(sessionId, agentId, file = subagents.transcript(sessionId, agentId)) {
  if (!file || !fs.existsSync(file)) return;
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')) || {};
  } catch {}
  const title = typeof meta.description === 'string' ? meta.description : typeof meta.agentType === 'string' ? meta.agentType : 'Subagent';
  viewerPanel.open({ file, kind: 'agent', sessionId, agentId, title });
}

// Documents VS Code can't show: in their own app, on this machine (in a remote window VS Code tries).
const OWN_APP = /\.(pdf|docx?|xlsx?|pptx?|od[tsp]|pages|numbers|key)$/i;

// A result on a session's card, by the key the panel sent back: only one its transcript recorded.
async function openResult(id, key) {
  const r = results.get(sessions.get(id)?.results, key);
  if (!r) return;
  if (r.key.startsWith('https://')) return vscode.env.openExternal(vscode.Uri.parse(r.key));
  if (!fs.existsSync(r.key)) return vscode.window.showInformationMessage(`"${path.basename(r.key)}" has been moved or deleted.`);
  const uri = vscode.Uri.file(r.key);
  if (OWN_APP.test(r.key) && !vscode.env.remoteName) return vscode.env.openExternal(uri);
  return vscode.commands.executeCommand('vscode.open', uri);
}

const runningAgents = (agents) => agents.filter((a) => a.state === 'run' && !a.workflow).length;

// The view's header: its title and what the session or agent is doing, from the same state the panel shows.
function describeView(t) {
  if (t.kind === 'agent') {
    const a = subagents.get(t.sessionId).find((x) => x.id === t.agentId);
    return { kind: 'agent', title: a?.desc || t.title, agentType: a?.type || '', status: a?.state || '', activity: a?.activity || '' };
  }
  const l = live.get(t.sessionId);
  const agents = runningAgents(subagents.get(t.sessionId));
  return {
    kind: 'session',
    title: titleOf(t.sessionId),
    status: l?.status || '',
    waitingFor: l?.status === 'waiting' ? l.waitingFor || '' : '',
    activity: l ? activity.describe(sessions.get(t.sessionId)?.act, l.status, l.waitingFor, { agents }) : '',
  };
}

async function pickView(id) {
  if (typeof id === 'string') return openView(id);
  const items = [...sessions.values()]
    .filter((s) => !prefs()[s.id]?.hidden || live.has(s.id))
    .sort((a, b) => !!live.has(b.id) - !!live.has(a.id) || b.mtime - a.mtime)
    .map((s) => ({
      label: `${live.has(s.id) ? '$(pulse) ' : ''}${titleOf(s.id)}`,
      description: [accountLabel(s.id), ago(s.mtime), s.cwd && path.basename(s.cwd)].filter(Boolean).join(' · '),
      id: s.id,
    }));
  const pick = await vscode.window.showQuickPick(items, { title: 'Open a read-only view of a session', matchOnDescription: true });
  if (pick) openView(pick.id);
}

// ---------------------------------------------------------------- panel

// The account's name for a session's card and pickers, once there is more than one account.
const accountLabel = (id) => (severalAccounts() ? accountOf(id).label : '');

// Running elsewhere and not idle past claudeSessions.elsewhereIdleHours: shown in "Running elsewhere". The others
// go to the day groups by their last activity, still marked as running elsewhere. A session that started one active
// there (in the Claude desktop app) stays too, so its child can be shown under it.
function activeElsewhere(id, seen = new Set()) {
  const l = live.get(id);
  if (!l || l.terminal || seen.has(id)) return false;
  seen.add(id);
  const agents = runningAgents(subagents.get(id));
  if (elsewhere.active(l, { hours: cfg().get('elsewhereIdleHours'), mtime: sessions.get(id)?.mtime, agents })) return true;
  return (childrenOf.get(id) || []).some((c) => activeElsewhere(c, seen));
}

async function readLineage() {
  const next = await readDesktop();
  if (next === lineage) return;
  lineage = next;
  childrenOf = new Map();
  for (const [child, { parentCliId }] of lineage) (childrenOf.get(parentCliId) || childrenOf.set(parentCliId, []).get(parentCliId)).push(child);
}

// Terminals open in the panel by default. Once you have a session open there, the panel offers the split layout,
// once: only while the setting is untouched, so anyone who has chosen a location never sees it.
function showSplitTip(anyOpen) {
  if (!anyOpen || context.globalState.get(SPLIT_TIP_KEY)) return false;
  const i = cfg().inspect('terminalLocation') || {};
  return i.globalValue === undefined && i.workspaceValue === undefined && i.workspaceFolderValue === undefined;
}

// Whether you're looking at this terminal, so it needs no notification. activeTerminal stays set when you move to a
// file: a terminal in an editor tab counts only while its tab is in front, and one in the terminal panel until an
// editor is used. The API doesn't say when you click back into that terminal, so then it notifies anyway.
function watching(t) {
  if (!vscode.window.state.focused || vscode.window.activeTerminal !== t) return false;
  const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((x) => isTerminalTab(x) && x.label === t.name);
  return tab ? tab.isActive && tab.group.isActive : !usedEditor;
}

// The session whose terminal is VS Code's active one, and whether it's in front: activeTerminal stays set
// when you move to a file, so a terminal tab that isn't the active tab of the active group is 'behind'.
function currentSession() {
  const t = vscode.window.activeTerminal;
  const id = t && [...live].find(([, e]) => e.terminal === t)?.[0];
  if (!id) return {};
  const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((x) => isTerminalTab(x) && x.label === t.name);
  return { id, behind: !!tab && !(tab.isActive && tab.group.isActive) };
}

// A subfolder relative to the workspace; a folder outside it (a session started elsewhere) by its name.
function folderOf(cwd, root) {
  if (!cwd || !root || cwd === root) return '';
  const rel = path.relative(root, cwd);
  return rel.startsWith('..') || path.isAbsolute(rel) ? path.basename(cwd) : rel;
}

function payload() {
  const all = prefs();
  const current = currentSession();
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const recent = [...sessions.values()].sort((a, b) => b.mtime - a.mtime).slice(0, cfg().get('maxRecent'));
  const ids = new Set(recent.map((s) => s.id));
  for (const id of live.keys()) ids.add(id);
  for (const [id, p] of Object.entries(all)) if (p.pinned && sessions.has(id)) ids.add(id);

  const list = [...ids].map((id) => {
    const s = sessions.get(id) || {};
    const p = all[id] || {};
    const l = live.get(id);
    const title = titleOf(id);
    const agents = subagents.get(id);
    const away = !!l && !l.terminal;
    const account = severalAccounts() ? accountOf(id) : undefined;
    return {
      id,
      title,
      color: colorOf(id) || '',
      // the Claude account it runs on, when claudeSessions.accounts lists several: a badge on its card
      account: account ? { label: account.label, color: account.color, dir: accountsOf.display(account.dir) } : null,
      lastPrompt: s.lastPrompt && s.lastPrompt !== title ? s.lastPrompt : '',
      mtime: s.mtime || l?.updatedAt || Date.now(),
      folder: folderOf(s.cwd, root),
      branch: s.branch && s.branch !== 'HEAD' ? s.branch : '',
      pinned: !!p.pinned,
      hidden: !!p.hidden,
      open: !!l?.terminal,
      elsewhere: away,
      // running elsewhere but idle past the cut-off: listed by day, not under "Running elsewhere"
      dormant: away && !activeElsewhere(id),
      app: away ? elsewhere.where(l) : '', // 'app': the Claude desktop app
      status: l?.status || '',
      waitingFor: l?.status === 'waiting' ? l.waitingFor || '' : '',
      // "Editing extension.js", or "Waiting for 2 agents" once its turn is over, while live
      activity: l ? activity.describe(s.act, l.status, l.waitingFor, { agents: runningAgents(agents) }) : '',
      unread: unread.has(id),
      current: id === current.id ? (current.behind ? 'behind' : 'front') : '',
      ctx: usage.forPayload(s, cfg().get('contextWindow')), // [tokens in use, window size]
      agents,
      results: cfg().get('showResults') ? results.forPayload(s.results) : undefined, // what it published, opened or sent you
      // the session that started it, when the Claude desktop app says so: shown under it
      parent: lineage.get(id)?.parentCliId || '',
      fork: lineage.get(id)?.kind === 'fork',
      // active or last active within the cut-off: shown in a parent's nested list without "Show N older"
      recent: elsewhere.recent({
        rec: away ? l : undefined,
        open: !!l?.terminal,
        hours: cfg().get('elsewhereIdleHours'),
        mtime: s.mtime,
        agents: runningAgents(agents),
      }),
    };
  });
  return {
    sessions: list,
    openOrder: sessionOrder(),
    pinOrder: pinOrder().filter((id) => ids.has(id)),
    mod: process.platform === 'darwin' ? '⌘' : 'Ctrl+',
    shortcuts: slotKeysOn(), // ⌘N hints
    splitTip: showSplitTip(list.some((s) => s.open)),
    totals: tally.tally(list), // across all live sessions, for the status bar
    notice: formatNotice, // Claude Code's files didn't look as expected
    reopen: notReopened().map((id) => ({ id, title: titleOf(id) })),
    skipPermissions: !!cfg().get('skipPermissions'),
  };
}

// The API can't rename a terminal, but renameWithArg renames the active one: so a session's tab takes the session's
// name (Rename…, /rename, Claude's title) while its terminal is active. Never a name another terminal has, since
// tabs are matched to sessions by name.
const tabNameAsked = new WeakMap(); // terminal → name last asked for, so a refused rename isn't retried every poll
function nameActiveTerminal() {
  const t = vscode.window.activeTerminal;
  const id = t && !movingTabs && [...live].find(([, e]) => e.terminal === t)?.[0];
  const name = id && transcripts.pickName({ alias: prefs()[id]?.alias, session: sessions.get(id), live: live.get(id) });
  if (!name || t.name === name || tabNameAsked.get(t) === name) return;
  if (vscode.window.terminals.some((o) => o !== t && o.name === name)) return;
  tabNameAsked.set(t, name);
  vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name });
}

function refresh() {
  const p = payload();
  const json = JSON.stringify(p);
  if (view && json !== lastPayload) {
    lastPayload = json;
    view.webview.postMessage({ type: 'state', ...p });
  }
  const open = p.sessions.filter((s) => s.open);
  const waiting = open.filter((s) => s.status === 'waiting').length;
  const attention = unread.size + waiting; // this window's, for the view badge
  // The status bar counts what's running across all live sessions, like the panel's chips: this window, other
  // terminals and the Claude desktop app.
  const all = p.totals;
  const kinds = tally.KINDS.filter((k) => all[k]);
  statusItem.text =
    `$(${attention || all.waiting ? 'bell-dot' : 'sparkle'}) ${open.length}` + kinds.map((k) => ` · ${tally.label(k, all[k])}`).join('');
  const split = (k) => (all[k] ? ` (${all.here[k]} in this window, ${all.elsewhere[k]} elsewhere)` : '');
  statusItem.tooltip =
    `All Claude sessions: ${all.working} working${split('working')}, ${all.waiting} waiting for you${split('waiting')}, ` +
    `${tally.label('agents', all.agents)}${split('agents')}.\n` +
    `This window: ${open.length} open, ${unread.size} done since you looked.`;
  statusItem.show();
  if (view) view.badge = attention ? { value: attention, tooltip: `${waiting} need you, ${unread.size} finished` } : undefined;
  nameActiveTerminal();
}

async function tick() {
  if (polling) return;
  polling = true;
  try {
    await scan();
    await dropSupersededColors();
    await dropSupersededNames();
    await pollLive();
    await subagents.update(sessions, live);
    await readLineage();
    const n = transcripts.formatNotice(liveFormat, scanned);
    formatMisses = n ? formatMisses + 1 : 0;
    formatNotice = formatMisses >= 3 ? n : ''; // not for a record caught mid-write
    refresh();
    viewerPanel.poll(); // read-only views: anything fs.watch missed, and their live status
  } catch (e) {
    console.error('[claude-sessions]', e);
  } finally {
    polling = false;
  }
}

class PanelProvider {
  resolveWebviewView(webviewView) {
    view = webviewView;
    lastPayload = '';
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    const wv = webviewView.webview;
    wv.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    wv.html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${wv.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${wv.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'))}">
</head><body>
<div id="app"></div>
<script nonce="${nonce}" src="${wv.asWebviewUri(vscode.Uri.joinPath(media, 'nesting.js'))}"></script>
<script nonce="${nonce}" src="${wv.asWebviewUri(vscode.Uri.joinPath(media, 'tally.js'))}"></script>
<script nonce="${nonce}" src="${wv.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'))}"></script>
</body></html>`;
    wv.onDidReceiveMessage((m) => handleMessage(m).catch((e) => vscode.window.showErrorMessage(String(e))));
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        lastPayload = '';
        refresh();
      }
    });
    webviewView.onDidDispose(() => (view = undefined));
  }
}

async function handleMessage(m) {
  switch (m.type) {
    case 'ready':
      lastPayload = '';
      return refresh();
    case 'open':
      return resumeMany(m.ids);
    case 'focus': {
      // A session running elsewhere opens read-only; resuming it here is in its ⋯ menu.
      const l = live.get(m.id);
      return l && !l.terminal ? openView(m.id) : resume(m.id);
    }
    case 'new':
      return newSession();
    case 'refresh':
      return tick();
    case 'pin':
      return setPinned(m.id, !prefs()[m.id]?.pinned);
    case 'reorder':
      return reorder(m.section, m.ids);
    case 'unhide':
      return setPref(m.id, { hidden: false });
    case 'more':
      return moreActions(m.id);
    case 'openAgent':
      return openAgentView(m.id, m.agent);
    case 'openResult':
      return openResult(m.id, m.key);
    case 'reopenLast':
      return restoreLast();
    case 'dismissLast':
      return setRemembered(remembered().filter((id) => live.get(id)?.terminal)).then(refresh);
    case 'splitTip':
      if (m.use) await cfg().update('terminalLocation', 'split', vscode.ConfigurationTarget.Global);
      return context.globalState.update(SPLIT_TIP_KEY, true).then(refresh);
    case 'skipPermissions':
      return cfg().update('skipPermissions', !!m.value, vscode.ConfigurationTarget.Global);
  }
}

// ---------------------------------------------------------------- activation

function activate(ctx) {
  context = ctx;
  loadAccounts();
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = 'claudeSessions.showPanel';
  viewerPanel.init({
    extensionUri: ctx.extensionUri,
    describe: describeView,
    openAgent: (t, agentId, file) => openAgentView(t.sessionId, agentId, file),
  });

  ctx.subscriptions.push(
    statusItem,
    vscode.window.registerWebviewViewProvider('claudeSessions.panel', new PanelProvider(), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('claudeSessions.resume', quickPickResume),
    vscode.commands.registerCommand('claudeSessions.new', newSession),
    vscode.commands.registerCommand('claudeSessions.restore', restoreLast),
    vscode.commands.registerCommand('claudeSessions.showPanel', () =>
      vscode.commands.executeCommand('claudeSessions.panel.focus')
    ),
    vscode.commands.registerCommand('claudeSessions.moveToSplit', moveSessionsToSplit),
    vscode.commands.registerCommand('claudeSessions.openViewer', pickView),
    { dispose: viewerPanel.disposeAll },
    vscode.commands.registerCommand('claudeSessions.enableSlotKeysInTerminal', enableSlotKeysInTerminal),
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      keepFilesLeft(e);
      followTabs();
      refresh(); // tab order drives ⌘1…⌘9, the active tab the current session
    }),
    vscode.window.tabGroups.onDidChangeTabGroups(refresh), // moving between the file and terminal groups
    ...Array.from({ length: 9 }, (_, i) =>
      vscode.commands.registerCommand(`claudeSessions.focus${i + 1}`, () => focusSlot(i + 1))
    ),
    vscode.commands.registerCommand('claudeSessions.toggleSkipPermissions', () =>
      cfg().update('skipPermissions', !cfg().get('skipPermissions'), vscode.ConfigurationTarget.Global)
    ),
    vscode.window.onDidCloseTerminal((t) => {
      const id = termSession.get(t) ?? pending.get(t);
      termSession.delete(t);
      termMisses.delete(t);
      pending.delete(t);
      pendingColor.delete(t);
      pendingName.delete(t);
      pendingDesktop.delete(t);
      handedOff.delete(t);
      if (id && t.exitStatus?.reason !== vscode.TerminalExitReason.Shutdown) {
        setRemembered(remembered().filter((x) => x !== id));
      }
      tick();
    }),
    vscode.window.onDidOpenTerminal(() => setTimeout(tick, 1500)),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed) usedEditor = true;
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      const { Mouse, Keyboard } = vscode.TextEditorSelectionChangeKind;
      if (e.kind === Mouse || e.kind === Keyboard) usedEditor = true;
    }),
    vscode.window.onDidChangeActiveTerminal((t) => {
      usedEditor = false;
      if (!movingTabs) for (const [id, e] of live) if (e.terminal === t) unread.delete(id);
      refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('claudeSessions')) return;
      if (e.affectsConfiguration('claudeSessions.terminalLocation') && splitMode()) moveSessionsToSplit();
      if (e.affectsConfiguration('claudeSessions.sessionShortcuts')) offerSlotKeysInTerminal();
      if (e.affectsConfiguration('claudeSessions.accounts') || e.affectsConfiguration('claudeSessions.command')) {
        loadAccounts();
        return tick(); // other folders to read
      }
      if (e.affectsConfiguration('claudeSessions.showResults') && results.enable(cfg().get('showResults'))) {
        transcripts.forget(); // not read while it was off
        tick();
      }
      refresh();
    })
  );

  results.enable(cfg().get('showResults'));
  const timer = setInterval(tick, POLL_MS);
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) });
  offerSlotKeysInTerminal();
  tick().then(restoreOnStartup);
}

function deactivate() {}

module.exports = { activate, deactivate };
