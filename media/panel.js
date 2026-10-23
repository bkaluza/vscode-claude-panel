// Session Panel webview. Renders the state the extension posts; every action goes back as a message.
(function () {
  const vscode = acquireVsCodeApi();
  const ui = Object.assign({ filter: '', selected: [], collapsed: { hidden: true } }, vscode.getState() || {});
  let state = { sessions: [], reopen: [], openOrder: [], pinOrder: [], skipPermissions: false };
  let loaded = false; // until the first state arrives, keep the saved selection
  let drag; // { id, list } while a card is dragged; renders wait until it's dropped
  let renderLater = false;
  ui.agents ||= {}; // session id → true (subagents expanded) or 'all' (older ones too)
  ui.results ||= {}; // the same for its results
  // session id → false / true (the sessions it started collapsed / expanded, as you left them), or 'all' (older ones
  // too). Unset: expanded while one of them is recent, collapsed when they're all older.
  ui.kids ||= {};
  let kids = new Map(); // parent id → the sessions nested under it, from the last render
  let byId = new Map();

  const COLOR_VARS = {
    red: '--vscode-terminal-ansiRed',
    orange: '--vscode-terminal-ansiYellow',
    yellow: '--vscode-terminal-ansiYellow',
    green: '--vscode-terminal-ansiGreen',
    cyan: '--vscode-terminal-ansiCyan',
    blue: '--vscode-terminal-ansiBlue',
    purple: '--vscode-terminal-ansiMagenta',
    pink: '--vscode-terminal-ansiBrightMagenta',
  };

  const ICONS = {
    search:
      '<path d="M10.5 10.5L14 14"/><circle cx="6.75" cy="6.75" r="4.75"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    refresh: '<path d="M13 3v3.5H9.5"/><path d="M12.6 6.5A5 5 0 1 0 13 9"/>',
    pin: '<path d="M6 2.5h4M7 2.5v4l-2.5 2.5h7L9 6.5v-4M8 9v4.5"/>',
    more: '<circle cx="3.5" cy="8" r=".9" fill="currentColor"/><circle cx="8" cy="8" r=".9" fill="currentColor"/><circle cx="12.5" cy="8" r=".9" fill="currentColor"/>',
    play: '<path d="M5 3.5l7 4.5-7 4.5z"/>',
    close: '<path d="M4 4l8 8M12 4l-8 8"/>',
    chevron: '<path d="M6 4l4 4-4 4"/>',
    history: '<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"/><path d="M2.5 2.5v2.5H5"/><path d="M8 5v3l2 1.5"/>',
    info: '<circle cx="8" cy="8" r="5.75"/><path d="M8 7.25v3.5"/><circle cx="8" cy="5.25" r=".5" fill="currentColor"/>',
    artifact: '<path d="M8 2.5l5.5 5.5L8 13.5 2.5 8z"/>',
    doc: '<path d="M4 2.5h5l3 3v8H4z"/><path d="M6.5 8.5h3M6.5 11h3"/>',
    pr: '<circle cx="4.5" cy="4" r="1.5"/><circle cx="4.5" cy="12" r="1.5"/><circle cx="11.5" cy="12" r="1.5"/><path d="M4.5 5.5v5M11.5 10.5V7a2 2 0 0 0-2-2H7.5"/>',
    file: '<path d="M10.5 6l-4 4a1.4 1.4 0 0 0 2 2l4.5-4.5a2.8 2.8 0 0 0-4-4L4.5 8a4.2 4.2 0 0 0 6 6"/>',
    plan: '<path d="M3 4.5l1 1 2-2M3 10.5l1 1 2-2M8.5 4.5H13M8.5 10.5H13"/>',
  };
  const icon = (name) =>
    `<svg class="i" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function save() {
    vscode.setState(ui);
  }

  function ago(ms) {
    const s = (Date.now() - ms) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
    return new Date(ms).toLocaleDateString();
  }

  function dayBucket(ms) {
    const d = new Date(ms);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const day = 86400000;
    if (d >= today) return 'Today';
    if (d >= today - day) return 'Yesterday';
    if (d >= today - 6 * day) return 'This week';
    return 'Older';
  }

  // ---------------------------------------------------------------- shell

  const app = document.getElementById('app');
  app.innerHTML = `
    <header class="top">
      <div class="search">
        ${icon('search')}
        <input id="filter" type="text" placeholder="Filter sessions" spellcheck="false" aria-label="Filter sessions">
        <button id="clearFilter" class="icon-btn ghost" title="Clear filter" hidden>${icon('close')}</button>
      </div>
      <div class="toolbar">
        <label class="switch" title="Start and resume sessions with --dangerously-skip-permissions">
          <input id="skip" type="checkbox" role="switch">
          <span class="track"><span class="thumb"></span></span>
          <span class="switch-label">Skip permissions</span>
        </label>
        <span class="spacer"></span>
        <button id="refresh" class="icon-btn" title="Refresh">${icon('refresh')}</button>
        <button id="new" class="btn primary" title="Start a new Claude session">${icon('plus')}<span>New</span></button>
      </div>
      <div id="summary" class="summary" role="toolbar" aria-label="Running across all sessions" hidden></div>
      <div id="selbar"></div>
    </header>
    <div id="banner"></div>
    <main id="list" role="list"></main>`;

  const $ = (id) => document.getElementById(id);
  const filterInput = $('filter');
  filterInput.value = ui.filter;

  filterInput.addEventListener('input', () => {
    ui.filter = filterInput.value;
    save();
    render();
  });
  filterInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      filterInput.value = ui.filter = '';
      save();
      render();
    }
  });
  $('clearFilter').addEventListener('click', () => {
    filterInput.value = ui.filter = '';
    save();
    render();
    filterInput.focus();
  });
  $('skip').addEventListener('change', (e) => vscode.postMessage({ type: 'skipPermissions', value: e.target.checked }));
  $('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  $('new').addEventListener('click', () => vscode.postMessage({ type: 'new' }));

  // One delegated handler for everything inside the dynamic parts.
  app.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const card = el.closest('[data-id]');
    const id = card?.dataset.id;
    switch (el.dataset.act) {
      case 'open':
        if (e.target.closest('label.check, .actions')) return;
        if (e.target.closest('.tree')?.parentElement === el) return; // between its toggles and lists
        vscode.postMessage({ type: 'focus', id });
        break;
      case 'play':
        vscode.postMessage({ type: 'focus', id });
        break;
      case 'pin':
        vscode.postMessage({ type: 'pin', id });
        break;
      case 'more':
        vscode.postMessage({ type: 'more', id });
        break;
      case 'unhide':
        vscode.postMessage({ type: 'unhide', id });
        break;
      case 'agents':
        if (ui.agents[id]) delete ui.agents[id];
        else ui.agents[id] = true;
        save();
        render();
        break;
      case 'kids':
        ui.kids[id] = !kidsFold(byId.get(id)).open;
        save();
        render();
        break;
      case 'chip':
        ui.chip = ui.chip === el.dataset.kind ? '' : el.dataset.kind;
        save();
        render();
        break;
      case 'kidsAll':
        ui.kids[id] = ui.kids[id] === 'all' ? true : 'all';
        save();
        render();
        break;
      case 'agentsAll':
        ui.agents[id] = ui.agents[id] === 'all' ? true : 'all';
        save();
        render();
        break;
      case 'agent':
        vscode.postMessage({ type: 'openAgent', id, agent: el.dataset.agent });
        break;
      case 'results':
        if (ui.results[id]) delete ui.results[id];
        else ui.results[id] = true;
        save();
        render();
        break;
      case 'resultsAll':
        ui.results[id] = ui.results[id] === 'all' ? true : 'all';
        save();
        render();
        break;
      case 'result':
        vscode.postMessage({ type: 'openResult', id, key: el.dataset.key });
        break;
      case 'section': {
        const key = el.dataset.key;
        ui.collapsed[key] = !ui.collapsed[key];
        save();
        render();
        break;
      }
      case 'selectSection': {
        const ids = el.dataset.ids.split(',');
        const all = ids.every((x) => ui.selected.includes(x));
        ui.selected = all ? ui.selected.filter((x) => !ids.includes(x)) : [...new Set([...ui.selected, ...ids])];
        save();
        render();
        break;
      }
      case 'openSelected':
        vscode.postMessage({ type: 'open', ids: ui.selected });
        ui.selected = [];
        save();
        render();
        break;
      case 'clearSelected':
        ui.selected = [];
        save();
        render();
        break;
      case 'reopenLast':
        vscode.postMessage({ type: 'reopenLast' });
        break;
      case 'chooseLast':
        ui.selected = [...new Set([...ui.selected, ...state.reopen.map((r) => r.id)])];
        save();
        render();
        break;
      case 'dismissLast':
        vscode.postMessage({ type: 'dismissLast' });
        break;
      case 'splitTipUse':
      case 'splitTipDismiss':
        vscode.postMessage({ type: 'splitTip', use: el.dataset.act === 'splitTipUse' });
        break;
    }
  });

  app.addEventListener('change', (e) => {
    if (!e.target.matches('.check input')) return;
    const id = e.target.closest('[data-id]').dataset.id;
    ui.selected = e.target.checked ? [...ui.selected, id] : ui.selected.filter((x) => x !== id);
    save();
    render();
  });

  app.addEventListener('keydown', (e) => {
    const card = e.target.closest?.('.card');
    if (!card || e.target !== card) return;
    if (e.key === 'Enter') vscode.postMessage({ type: 'focus', id: card.dataset.id });
    else if (e.key === ' ') {
      e.preventDefault();
      card.querySelector(':scope > .card-main .check input')?.click();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const cards = [...document.querySelectorAll('.card')];
      cards[cards.indexOf(card) + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
    }
  });

  // ---------------------------------------------------------------- reordering

  // Open and pinned sessions can be dragged within their section. The browser fires no
  // click after a drag, so a drop never opens a session.
  const idsIn = (list) => [...list.querySelectorAll(':scope > .card')].map((c) => c.dataset.id);

  // order.js's refill: `order` with the places `ids` hold refilled in ids' order.
  function refill(order, ids) {
    const base = [...order, ...ids.filter((id) => !order.includes(id))];
    const moving = new Set(ids);
    let i = 0;
    return base.map((id) => (moving.has(id) ? ids[i++] : id));
  }

  // The new order goes to the extension, and into the local state at once so the list doesn't lag behind.
  function reorder(section, ids) {
    const key = section === 'open' ? 'openOrder' : 'pinOrder';
    state[key] = refill(state[key] || [], ids);
    vscode.postMessage({ type: 'reorder', section, ids });
    render();
  }

  // Where a drop at this height lands: before the first card whose middle is below it, or at the end (null).
  function dropTarget(list, y) {
    return (
      [...list.querySelectorAll(':scope > .card')].find((c) => {
        const r = c.getBoundingClientRect();
        return y < r.top + r.height / 2;
      }) || null
    );
  }

  function clearDrop() {
    for (const el of document.querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after');
  }

  // A line where the card would land; none where dropping wouldn't move it.
  function showDrop(list, target) {
    clearDrop();
    const cards = [...list.querySelectorAll(':scope > .card')];
    const from = cards.findIndex((c) => c.dataset.id === drag.id);
    const to = target ? cards.indexOf(target) : cards.length;
    if (to === from || to === from + 1) return;
    if (target) target.classList.add('drop-before');
    else list.lastElementChild.classList.add('drop-after'); // the last card
  }

  function endDrag() {
    clearDrop();
    document.querySelector('.card.dragging')?.classList.remove('dragging');
    drag = undefined;
    if (renderLater) render();
  }

  app.addEventListener('dragstart', (e) => {
    const card = e.target.closest?.('.card[draggable="true"]');
    if (!card) return;
    drag = { id: card.dataset.id, list: card.parentElement };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', drag.id);
    card.classList.add('dragging');
  });
  app.addEventListener('dragover', (e) => {
    if (!drag) return;
    const list = e.target.closest?.('.cards');
    if (list !== drag.list) return clearDrop(); // other sections aren't drop targets
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    showDrop(list, dropTarget(list, e.clientY));
  });
  app.addEventListener('dragleave', (e) => {
    if (drag && !e.relatedTarget?.closest?.('.cards')) clearDrop();
  });
  app.addEventListener('drop', (e) => {
    const list = e.target.closest?.('.cards');
    if (!drag || list !== drag.list) return;
    e.preventDefault();
    const before = dropTarget(list, e.clientY)?.dataset.id;
    const ids = idsIn(list).filter((id) => id !== drag.id);
    const i = before ? ids.indexOf(before) : -1;
    ids.splice(i < 0 ? ids.length : i, 0, drag.id);
    const section = list.dataset.sort;
    endDrag();
    if (ids.join() !== idsIn(list).join()) reorder(section, ids);
  });
  app.addEventListener('dragend', () => drag && endDrag());

  // ---------------------------------------------------------------- rendering

  function statusPill(s) {
    if (s.status === 'waiting') {
      const why = s.waitingFor ? `Waiting for you: ${s.waitingFor}` : 'Waiting for you';
      return `<span class="pill waiting" title="${esc(why)}">Needs you</span>`;
    }
    if (s.unread) return '<span class="pill done" title="Finished while you were elsewhere">Done</span>';
    const agents = runningAgents(s); // background agents keep working after the session's own turn ends
    if (agents) {
      const label = (s.status === 'busy' ? 'Working · ' : '') + plural(agents, 'agent');
      return `<span class="pill busy" title="${esc(`${plural(agents, 'subagent')} running`)}"><span class="pulse"></span>${label}</span>`;
    }
    if (s.status === 'busy') return '<span class="pill busy"><span class="pulse"></span>Working</span>';
    if (s.status === 'starting') return '<span class="pill">Starting…</span>';
    if (s.elsewhere && !s.app) return '<span class="pill elsewhere" title="Running in another window or terminal">Elsewhere</span>';
    if (s.open) return `<span class="pill idle">${esc(s.status && s.status !== 'idle' ? s.status[0].toUpperCase() + s.status.slice(1) : 'Idle')}</span>`;
    return `<span class="when">${esc(ago(s.mtime))}</span>`;
  }

  const tokens = (n) =>
    n >= 1e6 ? `${+(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${n}`;

  // How full the context window is, as a thin bar plus "160K / 1M". Width comes from a 5% bucket class (u-0 … u-100):
  // the CSP blocks inline styles.
  function ctxRow(s) {
    if (!s.ctx) return '';
    const [used, size] = s.ctx;
    const pct = Math.min(100, (used / size) * 100);
    const level = pct >= 95 ? ' full' : pct >= 80 ? ' warn' : '';
    const why = `Context: ${used.toLocaleString()} tokens used, ${Math.max(0, size - used).toLocaleString()} left of ${size.toLocaleString()} (${Math.round(pct)}%)`;
    return `
          <div class="ctx${level}" title="${esc(why)}">
            <span class="ctx-bar"><span class="ctx-fill u-${Math.ceil(pct / 5) * 5}"></span></span>
            <span class="ctx-text">${esc(tokens(used))} / ${esc(tokens(size))}</span>
          </div>`;
  }

  // ---------------------------------------------------------------- subagents

  const AGENT_RECENT_MS = 3 * 3600000; // finished agents listed without "Show older"
  const AGENT_STATES = { run: 'running', done: 'done', failed: 'failed', stopped: 'stopped' };
  const runningAgents = (s) => (s.agents || []).filter((a) => a.state === 'run').length;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  function elapsed(ms) {
    const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }

  // The disclosure line under a session that has subagents: "› 37 agents · 1 running".
  function agentsToggle(s) {
    if (!s.agents?.length) return '';
    const open = !!ui.agents[s.id] || (ui.chip === 'agents' && runningAgents(s) > 0);
    const run = runningAgents(s);
    return `
          <button class="agents-toggle${open ? ' expanded' : ''}" data-act="agents" aria-expanded="${open}"
                  title="${open ? 'Hide' : 'Show'} subagents">
            ${icon('chevron')}<span>${plural(s.agents.length, 'agent')}</span>${run ? `<span class="agents-run">· ${run} running</span>` : ''}
          </button>`;
  }

  function agentRow(a) {
    const run = a.state === 'run';
    const time = run
      ? `<span class="agent-time" data-since="${a.start}">${elapsed(a.start)}</span>`
      : `<span class="agent-time">${esc(ago(a.end))}</span>`;
    const when = `Started ${new Date(a.start).toLocaleString()}${run ? '' : `, ${AGENT_STATES[a.state]} ${new Date(a.end).toLocaleString()}`}`;
    return `
        <button class="agent a-${a.state}${a.depth > 1 ? ` depth-${Math.min(a.depth, 3)}` : ''}" data-act="agent" data-agent="${esc(a.id)}"
                title="${esc(`${a.desc}\n${when}\nOpen read-only view`)}">
          <span class="agent-dot"></span>
          <span class="agent-desc">${esc(a.desc)}</span>
          ${time}
          <span class="agent-sub">${esc([a.type, (run && a.activity) || AGENT_STATES[a.state]].filter(Boolean).join(' · '))}</span>
        </button>`;
  }

  // Running agents plus those finished in the last few hours; the rest behind "Show N older".
  function agentList(s) {
    const mode = ui.agents[s.id] || (ui.chip === 'agents' && runningAgents(s) ? true : undefined);
    if (!mode || !s.agents?.length) return '';
    const cutoff = Date.now() - AGENT_RECENT_MS;
    let recent = s.agents.filter((a) => a.state === 'run' || a.end >= cutoff);
    if (!recent.length) recent = s.agents.slice(0, 5); // nothing lately: the last few
    const all = mode === 'all';
    const shown = all ? s.agents : recent;
    const older = s.agents.length - recent.length;
    const more = all
        ? older
          ? `<button class="link agents-more" data-act="agentsAll">Show recent only</button>`
          : ''
        : older
          ? `<button class="link agents-more" data-act="agentsAll">Show ${older} older</button>`
          : '';
    return `
      <div class="agents" data-id="${esc(s.id)}" role="group" aria-label="Subagents of ${esc(s.title)}">
        ${shown.map(agentRow).join('')}
        ${more}
      </div>`;
  }

  // ---------------------------------------------------------------- results

  const RESULTS_SHOWN = 5; // newest results listed without "Show older"
  const RESULT_KINDS = { artifact: 'artifact', doc: 'doc', pr: 'PR', mr: 'MR', file: 'file', plan: 'plan' };

  // The disclosure line under a session that published, opened or sent you something: "› 3 results".
  function resultsToggle(s) {
    if (!s.results?.length) return '';
    const open = !!ui.results[s.id];
    return `
          <button class="agents-toggle${open ? ' expanded' : ''}" data-act="results" aria-expanded="${open}"
                  title="${open ? 'Hide' : 'Show'} what it published, opened and sent you">
            ${icon('chevron')}<span>${plural(s.results.length, 'result')}</span>
          </button>`;
  }

  function resultRow(r) {
    const kind = RESULT_KINDS[r.kind] || r.kind;
    return `
        <button class="agent result" data-act="result" data-key="${esc(r.key)}"
                title="${esc(`${r.title}\n${r.key}\n${kind}, ${new Date(r.at).toLocaleString()}`)}">
          ${icon(r.kind === 'mr' ? 'pr' : ICONS[r.kind] ? r.kind : 'file')}
          <span class="agent-desc">${esc(r.title)}</span>
          <span class="agent-time">${esc(kind)}</span>
        </button>`;
  }

  function resultList(s) {
    const mode = ui.results[s.id];
    if (!mode || !s.results?.length) return '';
    const all = mode === 'all';
    const older = s.results.length - RESULTS_SHOWN;
    const more =
      older > 0 ? `<button class="link agents-more" data-act="resultsAll">${all ? 'Show recent only' : `Show ${older} older`}</button>` : '';
    return `
      <div class="agents results" data-id="${esc(s.id)}" role="group" aria-label="Results of ${esc(s.title)}">
        ${(all ? s.results : s.results.slice(0, RESULTS_SHOWN)).map(resultRow).join('')}
        ${more}
      </div>`;
  }

  // What a live session is doing now ("Editing extension.js"), or what it waits for. Derived from the transcript, so
  // a step behind: Claude Code writes each block when it's finished.
  function activityLine(s) {
    if (!s.activity) return '';
    return `<div class="activity${s.status === 'waiting' ? ' waiting' : ''}" title="${esc(s.activity)}">${esc(s.activity)}</div>`;
  }

  // ---------------------------------------------------------------- sessions started by another one

  // The disclosure line under a session that started others in the Claude desktop app: "› 3 sessions". Collapsed,
  // it says which of them are working or need you.
  function kidsToggle(s) {
    const list = kids.get(s.id);
    if (!list?.length) return '';
    const open = kidsFold(s).open;
    const all = Nesting.family(s.id, kids).slice(1).map((id) => byId.get(id));
    const busy = all.filter((k) => k.status === 'busy').length;
    const waiting = all.filter((k) => k.status === 'waiting').length;
    const note = open ? '' : [busy ? `${busy} working` : '', waiting ? `${waiting} need${waiting > 1 ? '' : 's'} you` : ''].filter(Boolean);
    return `
          <button class="agents-toggle kids-toggle${open ? ' expanded' : ''}" data-act="kids" aria-expanded="${open}"
                  title="${open ? 'Hide' : 'Show'} the sessions it started in the Claude app">
            ${icon('chevron')}<span>${plural(all.length, 'session')}</span>${note.length ? `<span class="agents-run">· ${esc(note.join(' · '))}</span>` : ''}
          </button>`;
  }

  // The sessions nested under a card, each a full card of its own: those active or recent (by the
  // claudeSessions.elsewhereIdleHours cut-off, or with a recent one under them), the rest behind "Show N older", as
  // for subagents.
  // A parent's nested list as it's shown now: Nesting.fold, then whether you expanded or collapsed it yourself.
  function kidsFold(s) {
    const mode = ui.kids[s.id];
    const f = Nesting.fold(kids.get(s.id) || [], (id) => Nesting.family(id, kids).some((x) => byId.get(x).recent), mode === 'all');
    if (ui.chip) return { shown: kids.get(s.id) || [], older: 0, open: true }; // filtered to what's running: all of them
    return { ...f, open: mode === undefined ? f.open : mode !== false };
  }

  function kidList(s) {
    if (!kids.get(s.id)?.length) return '';
    const { shown, older, open } = kidsFold(s);
    if (!open) return '';
    const all = ui.kids[s.id] === 'all';
    const more = older
      ? `<button class="link agents-more" data-act="kidsAll">${all ? 'Show recent only' : `Show ${older} older`}</button>`
      : '';
    return `
      <div class="kids" data-id="${esc(s.id)}" role="group" aria-label="Sessions started by ${esc(s.title)}">
        ${shown.map((id) => card(byId.get(id), false)).join('')}
        ${more}
      </div>`;
  }

  // A fork made in the Claude app, nested under the session it was forked from.
  function forkTag(s) {
    if (!s.fork || !kids.get(s.parent)?.includes(s.id)) return '';
    const from = byId.get(s.parent)?.title;
    return `<span class="pill elsewhere fork" title="${esc(`Forked from ${from || 'the session above'} in the Claude app`)}">Fork</span>`;
  }

  // Where a session running elsewhere runs, when we know: the Claude desktop app. In place of the Elsewhere pill, and
  // next to Working / Needs you while it's busy.
  function whereTag(s) {
    return s.app === 'app' ? '<span class="pill elsewhere app" title="Running in the Claude desktop app">Claude app</span>' : '';
  }

  // ⌘1…⌘9 jump to the first nine open sessions, in openOrder (unless claudeSessions.sessionShortcuts is off).
  function slotHint(s) {
    const i = s.open && state.shortcuts ? state.openOrder.indexOf(s.id) : -1;
    return i >= 0 && i < 9 ? `<kbd class="slot" title="Press ${esc(state.mod)}${i + 1} to switch here">${esc(state.mod)}${i + 1}</kbd>` : '';
  }

  // Inside a card, under its text, one tree of what it started: the sessions (nested cards), the subagents, then its
  // results, each list right under its own toggle, all at the same indent. The card's frame, colour bar and tint wrap it.
  function treeOf(s) {
    const html = kidsToggle(s) + kidList(s) + agentsToggle(s) + agentList(s) + resultsToggle(s) + resultList(s);
    return html.trim() ? `<div class="tree" data-id="${esc(s.id)}">${html}</div>` : '';
  }

  function card(s, movable) {
    const tree = treeOf(s);
    const color = COLOR_VARS[s.color] ? s.color : 'none';
    const selected = ui.selected.includes(s.id);
    const meta = [
      s.open || s.elsewhere ? ago(s.mtime) : '',
      s.folder ? `▸ ${s.folder}` : '',
      s.branch ? `⎇ ${s.branch}` : '',
    ].filter(Boolean);
    const check = s.open
      ? `<span class="check live" title="Open in this window"><span class="live-dot"></span></span>`
      : `<label class="check" title="Select"><input type="checkbox" ${selected ? 'checked' : ''} aria-label="Select ${esc(s.title)}"></label>`;
    return `
      <div class="card c-${color}${s.open ? ' open' : ''}${s.activity ? ' active' : ''}${selected ? ' selected' : ''}${s.unread ? ' unread' : ''}${s.current ? ` current ${s.current}` : ''}${tree ? ' has-tree' : ''}"
           role="listitem" tabindex="0" data-id="${esc(s.id)}" data-act="open"
           ${movable ? 'draggable="true"' : ''}
           title="${s.current ? 'Current terminal' : s.open ? 'Show terminal' : s.elsewhere ? 'Open read-only view' : 'Resume in a new terminal'}"
           ${s.current ? 'aria-current="true"' : ''}>
        <div class="card-main">
        ${check}
        <div class="body">
          <div class="row1">
            <span class="title">${esc(s.title)}</span>
            ${slotHint(s)}
            ${forkTag(s)}
            ${whereTag(s)}
            ${statusPill(s)}
          </div>
          ${s.lastPrompt ? `<div class="prompt">${esc(s.lastPrompt)}</div>` : ''}
          ${activityLine(s)}
          <div class="foot">
          ${meta.length ? `<div class="meta">${meta.map(esc).join('<span class="sep">·</span>')}</div>` : ''}
          ${ctxRow(s)}
          </div>
        </div>
        <div class="actions">
          ${s.hidden ? `<button class="icon-btn" data-act="unhide" title="Unhide">${icon('history')}</button>` : ''}
          <button class="icon-btn${s.pinned ? ' on' : ''}" data-act="pin" title="${s.pinned ? 'Unpin' : 'Pin'}">${icon('pin')}</button>
          <button class="icon-btn" data-act="more" title="More actions">${icon('more')}</button>
        </div>
        </div>${tree}
      </div>`;
  }

  function section(key, label, items, opts = {}) {
    if (!items.length) return '';
    const collapsed = !!ui.collapsed[key] && !ui.chip; // filtered to what's running: every section shows it
    const selectable = items.filter((s) => !s.open).map((s) => s.id);
    const allSel = selectable.length && selectable.every((id) => ui.selected.includes(id));
    const movable = opts.sortable && items.length > 1;
    return `
      <section class="section${opts.quiet ? ' quiet' : ''}">
        <div class="section-head">
          <button class="section-toggle${collapsed ? ' collapsed' : ''}" data-act="section" data-key="${key}" aria-expanded="${!collapsed}">
            ${icon('chevron')}<span>${esc(label)}</span><span class="count">${opts.count ?? items.length}</span>
          </button>
          ${
            selectable.length > 1 && !collapsed
              ? `<button class="link" data-act="selectSection" data-ids="${selectable.map(esc).join(',')}">${allSel ? 'Unselect all' : 'Select all'}</button>`
              : ''
          }
        </div>
        ${collapsed ? '' : `<div class="cards"${movable ? ` data-sort="${key}"` : ''}>${items.map((s) => card(s, movable)).join('')}</div>`}
      </section>`;
  }

  function matches(s, q) {
    if (!q) return true;
    const hay = `${s.title} ${s.lastPrompt} ${s.folder} ${s.branch} ${s.color}${s.app === 'app' ? ' claude app' : ''}`.toLowerCase();
    return q
      .toLowerCase()
      .split(/\s+/)
      .every((w) => hay.includes(w));
  }

  function render() {
    renderLater = !!drag; // replacing the cards mid-drag would cancel it
    if (drag) return;
    $('skip').checked = state.skipPermissions;
    document.body.classList.toggle('skipping', state.skipPermissions);
    $('clearFilter').hidden = !ui.filter;

    byId = new Map(state.sessions.map((s) => [s.id, s]));
    if (loaded) {
      ui.selected = ui.selected.filter((id) => byId.has(id) && !byId.get(id).open);
    }

    // Claude Code's files didn't look as expected: say so, quietly.
    const notice = state.notice
      ? `<div class="notice" role="status">${icon('info')}<span>${esc(state.notice)}</span></div>`
      : '';

    // One-time tip while terminals open in the panel by default.
    const tip = state.splitTip
      ? `<div class="banner tip">
          <div class="banner-text">
            <strong>Tip: sessions beside your files</strong>
            <span class="wrap">Open session terminals as tabs in a right-hand editor group, with files on the left.</span>
          </div>
          <div class="banner-actions">
            <button class="btn primary" data-act="splitTipUse">Use split layout</button>
            <button class="icon-btn" data-act="splitTipDismiss" title="Dismiss">${icon('close')}</button>
          </div>
        </div>`
      : '';

    // Banner: sessions that were open last time and aren't yet.
    const reopen = state.reopen;
    $('banner').innerHTML = notice + (reopen.length
      ? `<div class="banner">
          <div class="banner-text">
            <strong>${reopen.length} session${reopen.length > 1 ? 's were' : ' was'} open last time</strong>
            <span>${esc(reopen.slice(0, 3).map((r) => r.title).join(', '))}${reopen.length > 3 ? ` and ${reopen.length - 3} more` : ''}</span>
          </div>
          <div class="banner-actions">
            <button class="btn primary" data-act="reopenLast">${icon('history')}<span>Reopen all</span></button>
            <button class="btn" data-act="chooseLast">Choose</button>
            <button class="icon-btn" data-act="dismissLast" title="Forget">${icon('close')}</button>
          </div>
        </div>`
      : '') + tip;

    $('selbar').innerHTML = ui.selected.length
      ? `<div class="selbar">
          <span>${ui.selected.length} selected</span>
          <span class="spacer"></span>
          <button class="btn" data-act="clearSelected">Clear</button>
          <button class="btn primary" data-act="openSelected">${icon('play')}<span>Open ${ui.selected.length}</span></button>
        </div>`
      : '';

    // Across all live sessions: the chips at the top. One that's pressed filters the list (with the text filter, if
    // any); it lets go once nothing it counts is left.
    const totals = Tally.tally(state.sessions);
    if (loaded && ui.chip && !totals[ui.chip]) ui.chip = '';
    const chips = Tally.KINDS.filter((k) => totals[k]);
    $('summary').hidden = !chips.length;
    $('summary').innerHTML = chips
      .map((k) => {
        const on = ui.chip === k;
        const where = `${totals.here[k]} in this window, ${totals.elsewhere[k]} elsewhere`;
        return `<button class="chip chip-${k}${on ? ' on' : ''}" data-act="chip" data-kind="${k}" aria-pressed="${on}"
                  title="${esc(`${on ? 'Show all sessions' : 'Show only these'} (${where})`)}">${k === 'working' || k === 'agents' ? '<span class="pulse"></span>' : ''}${esc(Tally.label(k, totals[k]))}</button>`;
      })
      .join('');

    const q = ui.filter.trim();
    const chip = ui.chip || '';
    const reveal = !!(q || chip); // hidden sessions show up when you look for them
    const list = state.sessions.filter((s) => matches(s, q) && (!chip || Tally.matches(chip, s)));
    const rank = (order) => (id) => {
      const i = (order || []).indexOf(id);
      return i < 0 ? 1e9 : i;
    };
    const openRank = rank(state.openOrder);
    const pinRank = rank(state.pinOrder);
    const byTime = (a, b) => b.mtime - a.mtime;

    // The section each session belongs in on its own: 0 open in this window, 1 running elsewhere (and active; one
    // idle there past the cut-off is listed by day like the rest), 2 pinned, 3 by day; hidden ones aren't ranked.
    const rankOf = (s) =>
      s.open ? 0 : s.elsewhere && !s.dormant ? 1 : s.hidden && !reveal ? undefined : s.pinned ? 2 : 3;
    const ranked = list.map((s) => ({ id: s.id, parent: s.parent, rank: rankOf(s), s })).filter((x) => x.rank !== undefined);
    const nested = Nesting.nest(ranked);
    // Nested sessions in the order they were last active, the newest first.
    kids = Nesting.children(nested, ranked.map((x) => x.s).sort(byTime));
    const top = (rank) => ranked.filter((x) => x.rank === rank && !nested.has(x.id)).map((x) => x.s);
    // A section counts its own sessions, nested ones included, but not those nested from other sections.
    const count = (items, rank) =>
      items.reduce((n, s) => n + Nesting.family(s.id, kids).filter((id) => rankOf(byId.get(id)) === rank).length, 0);
    // A family in the day groups is as recent as its newest member.
    const familyTime = (s) => Math.max(...Nesting.family(s.id, kids).map((id) => byId.get(id).mtime));

    const open = top(0).sort((a, b) => openRank(a.id) - openRank(b.id) || byTime(a, b));
    const elsewhere = top(1).sort(byTime);
    const pinned = top(2).sort((a, b) => pinRank(a.id) - pinRank(b.id) || byTime(a, b));
    const recent = top(3).sort((a, b) => familyTime(b) - familyTime(a));
    const hidden = reveal ? [] : list.filter((s) => !s.open && !(s.elsewhere && !s.dormant) && s.hidden && !s.pinned).sort(byTime);

    const groups = {};
    for (const s of recent) (groups[dayBucket(familyTime(s))] ||= []).push(s);

    let html =
      section('open', 'Open in this window', open, { sortable: true, count: count(open, 0) }) +
      section('elsewhere', 'Running elsewhere', elsewhere, { count: count(elsewhere, 1) }) +
      section('pinned', 'Pinned', pinned, { sortable: true, count: count(pinned, 2) }) +
      ['Today', 'Yesterday', 'This week', 'Older'].map((g) => section(`g-${g}`, g, groups[g] || [], { count: count(groups[g] || [], 3) })).join('') +
      section('hidden', 'Hidden', hidden, { quiet: true });

    if (!html) {
      html = q || chip
        ? `<div class="empty"><p>No sessions match${q ? ` “${esc(q)}”` : ''}${chip ? ` (showing only: ${esc(Tally.label(chip, totals[chip]))})` : ''}.</p></div>`
        : `<div class="empty">
             <p><strong>No Claude sessions in this workspace yet.</strong></p>
             <p>Start one and it will show up here, along with any you run in a terminal yourself.</p>
             <button class="btn primary" id="emptyNew">${icon('plus')}<span>New session</span></button>
           </div>`;
    }

    const listEl = $('list');
    const focusedId = document.activeElement?.closest?.('.card')?.dataset.id;
    const scroll = listEl.scrollTop;
    listEl.innerHTML = html;
    listEl.scrollTop = scroll;
    if (focusedId) listEl.querySelector(`.card[data-id="${CSS.escape(focusedId)}"]`)?.focus();
    $('emptyNew')?.addEventListener('click', () => vscode.postMessage({ type: 'new' }));
  }

  window.addEventListener('message', (e) => {
    if (e.data?.type !== 'state') return;
    state = e.data;
    loaded = true;
    render();
  });

  // Keep "5m ago" honest between state updates.
  setInterval(render, 60000);
  // Running subagents' elapsed time, without a full render.
  setInterval(() => {
    for (const el of document.querySelectorAll('[data-since]')) el.textContent = elapsed(+el.dataset.since);
  }, 5000);

  render();
  vscode.postMessage({ type: 'ready' });
})();
