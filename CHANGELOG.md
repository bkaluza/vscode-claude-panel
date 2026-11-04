# Changelog

## Unreleased

- Sessions started with `claude --bg` are listed under the session that started them, marked *Background*; with
  `claudeSessions.wakeParent` on, that session is told (its name and `claude logs <id>`) when one finishes, while
  you aren't looking at its terminal. Thanks to Klemen Kubelj.
- With several accounts, a `~/.claude` account whose `command` is a shell alias starts again (the panel types
  `unset CLAUDE_CONFIG_DIR &&`, not `env -u`). Thanks to Klemen Kubelj.

## 0.14.0

- **Workflow runs** among a session's subagents: one row per run, with its phase and how many of its agents are
  done (*review-mr · 5/11 done*), and the agents it started folded under it, open while it runs. An agent
  counts as done only once the run's journal has its result, the run's time starts at its launch, and up to 100 of
  its agents are listed. They open in the read-only view like other subagents, nested ones too. The chips and the
  status bar count a run's agents, not the run. Thanks to Klemen Kubelj.
- Resuming a session no longer picks a terminal the panel closed itself (*Close session*, or after handing the
  session to Claude Desktop), which some editors keep listing and which fail when used again; nothing still queued
  for it (`/color`, `/rename`) is sent. Thanks to Klemen Kubelj.
- A terminal VS Code revived after a restart is reused only while its shell still runs; *Starting…* clears after
  30 s. Thanks to Klemen Kubelj.

## 0.13.0

- **Cache timer**: a running session that's idle or waiting for you says next to its time how long its prompt
  cache stays warm, *◷ 42m*, amber in the last five minutes, then *cold*. It's 1 h or 5 min from Claude's last
  reply, as its transcript records the cache it wrote (5 min when it doesn't say). The tooltip has when it goes
  cold and how many tokens it'd take to cache again. `claudeSessions.showCacheTimer` turns it off.
- **Results**: *› N results* on a card lists the artifacts and docs a session published, the pull and merge
  requests it opened, the files it sent you and the plans you approved. Click one to open it. Turn it off with
  `claudeSessions.showResults`. Thanks to Klemen Kubelj.
- **Resume in Claude Desktop**, in the `⋯` menu of a session open in a terminal (macOS and Windows): sends
  `/desktop` once the session is idle and closes the terminal when the desktop app runs it. Only while that
  terminal is still the session's: if nothing comes of it within a minute, or another session runs there by then,
  the terminal stays. Offered only for sessions on Claude Code's default account (`~/.claude`), or with no
  accounts configured, since the desktop app runs them on the account it's signed into. Thanks to Klemen Kubelj.
- **Several Claude accounts** (`claudeSessions.accounts`, one config directory each): the panel lists the
  sessions of all of them, shows the account on each card, asks which one a new session runs on, and resumes a
  session on its own. With more than one, the command the panel types says which account itself
  (`CLAUDE_CONFIG_DIR=… claude …`, or `env -u CLAUDE_CONFIG_DIR claude …` for `~/.claude`), so a terminal VS Code
  revived after a reload, or a shell profile, can't start it on another; on Windows a terminal is reused only when
  it was made for that account. Two entries for the same folder (a symlink) count once, and a session found under
  two accounts (a copied config directory) is listed once, from its newer transcript or the account it runs on.
  *Copy resume command* unsets `CLAUDE_CONFIG_DIR` for `~/.claude` where VS Code has it set. Thanks to Klemen
  Kubelj.

## 0.12.0

- **What's running everywhere**, at the top of the panel: *3 working · 1 needs you · 2 agents running*, counted
  across every live session: this window, other terminals and the Claude desktop app, hidden ones and those
  nested or idle past the cut-off included. Click one to list only those sessions (hidden ones too, every section
  and nested list open; the text filter still applies), click it again for all. It lets go once there's nothing
  left to show.
- The status bar counts the same: what's working, waiting for you and agents running across all sessions, with
  the split between this window and elsewhere in its tooltip. The badge on the panel icon is still this window's.

## 0.11.4

- *Done* and *needs you* notifications, and the panel's unread mark, are no longer skipped for the session whose
  terminal you were last in after you've moved to a file: VS Code keeps that terminal "active". A terminal in an
  editor tab now counts as watched only while its tab is in front, and one in the terminal panel until you use an
  editor. Thanks to the reader on X who spotted it in the code.

## 0.11.3

- In the ⌘⌥R picker, Enter resumes the highlighted session when nothing is ticked (it did nothing before), and the
  most recent one is highlighted when it opens. Thanks to Klemen Kubelj.
- ⌘⌥C and ⌘⌥R now work while a session's terminal has focus too: the one-time prompt (and *Session Panel: Enable
  Shortcuts in Terminals*, was *Enable Cmd+1–9 in Terminals*) adds them to `terminal.integrated.commandsToSkipShell`
  along with ⌘1–9. New: ⌘⌥N (Ctrl+Alt+N) starts a new session, from a terminal or the panel. Thanks to Klemen
  Kubelj.
- Alt+Up / Alt+Down no longer move sessions in the panel: they only worked on a card focused with Tab, which a
  click never leaves you on. Drag a session, or use *Move up* / *Move down* in its `⋯` menu.
- The README lists the keys for macOS (⌘, ⌥) and Windows/Linux side by side, and explains moving sessions.

## 0.11.2

- A card's agents and sessions toggles and their lists are inside its frame again: its colour bar, tint, hover and
  the current session's frame take them in, as in 0.10.

## 0.11.1

- A session's terminal tab takes the session's name (Rename…, `/rename`, Claude Code's title) while it's the active
  terminal; it kept the name it was opened with before. Thanks to Klemen Kubelj.
- *Rename…* in the panel also renames the session in Claude Code (`/rename`, sent when the session is idle, or on
  its next resume from the panel), and when Claude Code's own name changes afterwards (`/rename` in the terminal)
  the panel follows it. Clearing the name in *Rename…* drops only the panel's: Claude Code has no command to clear
  its own, so the session goes back to that. Names picked before this are kept until Claude Code's name changes.

## 0.11.0

- *Running elsewhere* lists only sessions that are active there: working, waiting for you, running subagents, or
  idle for less than an hour. The Claude desktop app keeps a session running for as long as it's in its sidebar, so
  that section filled up with sessions idle for days. Those now go to *Today*, *This week* … by their last activity,
  still marked as running elsewhere (clicking one opens it read-only, and resuming it still warns), and move back as
  soon as they're busy again. Its count is what it shows. The hour is `claudeSessions.elsewhereIdleHours`; `0` keeps
  them all in the section as before.
- Sessions running in the Claude desktop app are tagged *Claude app*, in place of *Elsewhere*.
- **Sessions started by another one** in the Claude desktop app are listed under it (*› 3 sessions*, collapsible),
  each a full card of its own, a little quieter than the one above; forks made in the app say *Fork*. Those idle
  or finished for longer than `claudeSessions.elsewhereIdleHours` are behind *Show N older*, as for subagents. Only
  what the app records counts (macOS), so sessions started elsewhere aren't nested. A child stays in its own section when its parent's is further down: one
  running elsewhere isn't moved under a finished parent in *Today*. A session running elsewhere that started one
  active there stays in *Running elsewhere* with it. Section counts are the sessions that belong there, nested ones
  included.
- A card's nested sessions and subagents each open right under their own toggle, sessions first, at one indent.
- Hovering a session running elsewhere says *Open read-only view*, which is what clicking it does.

## 0.10.2

- On the VS Code Marketplace, as `bkaluza.claude-session-panel` (`claude-sessions` was taken there). The extension
  ID changes with it, so if you installed a `.vsix` before, uninstall the old *Session Panel for Claude Code*
  (`bkaluza.claude-sessions`). Pins, names, colours and the saved order don't carry over; settings do.

## 0.10.1

- Resuming a session that's running elsewhere, or isn't in this workspace's transcripts, starts in that session's
  own folder. Thanks to Klemen Kubelj.
- Picking a colour in the panel also sets it in Claude Code (`/color`, sent when the session is idle, or on its
  next resume from the panel; *none* sends `/color default`), and when Claude Code's own colour changes afterwards
  the panel follows it. Panel colours picked before this are dropped where Claude Code has its own. Thanks to
  Klemen Kubelj.

## 0.10.0

- **Activity line**: a live session's card says what it's doing now: *Editing extension.js*, *Running npm test*,
  *Searching for 'foo'*, *Running 2 agents*, *Thinking…*, *Waiting: permission prompt*. Its last prompt shrinks to
  one line meanwhile. Running subagents show their current step in place of "running".
- **Read-only view**: a session's transcript in an editor tab, following it live. Prompts, replies (with code,
  bold and lists), tool calls with their input and result, errors in red, subagent calls and completions with
  *Open subagent view*, compactions, turn times, and a header with status, model, branch and context use. Opens
  from the `⋯` menu, **Session Panel: Open Read-only View…**, or by clicking a subagent (which opened the raw JSONL
  before; *Raw file* in the view still does).
- Both are read from the transcript, so they trail by one block: Claude Code writes a block when it's finished.
- Clicking a session that's *running elsewhere* opens it read-only instead of offering to resume it a second time.
  Resuming it here is *Open here as well…* in its `⋯` menu, which explains the choices: view read-only, continue
  in a copy, or open the same session here too.
- Sessions running elsewhere that were started in another folder now open read-only too (*View read-only* did
  nothing for them), and their cards get their title, folder, branch, context use and subagents. *Continue in a
  copy* starts in their folder. One with no transcript yet says so.
- A session whose turn is over while its background agents run says *Waiting for 2 agents* instead of
  *Thinking…*; with none left it says *Finishing…* until Claude Code reports it idle.
- Subagents no longer stay *running* after they've finished:
  - a nested agent resumed after its parent agent had finished reports its completion to the session, and that
    now counts too;
  - an agent whose transcript ends on its final reply and hasn't changed since is shown as done, even when no
    completion notice was found.
- A running subagent with no transcript writes for 10 minutes says *Quiet for 40m* in front of its step, so a
  stuck one stands out (it may also just be in one long command).

## 0.9.0

- **Windows**: sessions get their titles (the drive letter's case no longer hides the workspace's transcripts) and
  are linked to their terminals (the process table comes from PowerShell, since there's no `ps`). Thanks, Tin Pren.
- Releases attach the `.vsix` to a GitHub release; the README's install steps point there.

## 0.8.2

- New sessions now get the colour you picked inside Claude Code too: there's no command-line option for it, so
  the extension sends `/color` once the session is ready.
- Session colours now match Claude Code's own (the panel and terminal tabs used the editor theme's terminal
  colours before). They're theme colours (`claudeSessions.red` …), so `workbench.colorCustomizations` can change them.

## 0.8.1

- *Close session* in the `⋯` menu of an open session closes its terminal, asking first if it's still working
  or waiting for you. It can be resumed later.

## 0.8.0

- **Put sessions in your own order**: drag *Open in this window* and *Pinned* sessions within their section, press
  Alt+Up / Alt+Down on one, or use *Move up* / *Move down* in its `⋯` menu. Cmd+1–9 and the ⌘N hints follow.
- The open order is kept per workspace, new sessions go to the end, and sessions reopened after a restart come
  back in it. Session terminals in editor tabs are moved to match; dragging a terminal tab yourself reorders the
  panel. Terminals in the terminal panel can't be moved by an extension, so for them only the panel changes.
- Pinned sessions keep the order you give them; newly pinned ones go to the end (previously: most recent first).

## 0.7.0

Getting ready for the Marketplace and Open VSX.

- **Renamed to Session Panel for Claude Code** (was *Claude Sessions*). The extension ID and the
  `claudeSessions.*` settings are unchanged, so pins, names, colours and remembered sessions carry over.

- **Terminals open in the terminal panel by default** (`claudeSessions.terminalLocation: "panel"`). The split
  layout (session terminals as tabs in a right-hand editor group, files on the left) is one click away: the
  panel offers it once, or set `"split"`. If you relied on the old default, set it explicitly.
- **Cmd+1–9 no longer edits your settings silently.** To work while a terminal has focus they must be listed in
  `terminal.integrated.commandsToSkipShell`; the extension now asks once (*Allow* / *Not now*), and
  *Session Panel: Enable Cmd+1–9 in Terminals* does it later.
- New setting `claudeSessions.sessionShortcuts` turns Cmd+1–9 (and the ⌘N hints) off.
- Respects `CLAUDE_CONFIG_DIR` (falls back to `~/.claude`).
- If a Claude Code update changes its session files beyond recognition, the panel says so instead of
  quietly showing less.
- Restricted Mode: the workspace can't change the launch command, its arguments or skip-permissions.
- Runs where Claude Code runs (workspace extension), including Remote and WSL windows.
- Requires VS Code 1.106 or later (the first release with Secondary Side Bar view containers).
- MIT licence, icon, unit tests, CI.

## 0.6.0

- The session whose terminal is active is framed in its colour, with a ring round its dot (fainter when you've
  moved to a file).
- Yellow and orange are toned down in dark themes.
- Subagent dots: running green and pulsing, done grey, failed red, stopped hollow.

## 0.5.0

- **Cmd+1 … Cmd+9** switch to open session 1–9, in tab order, shown as ⌘N hints in the panel.

## 0.4.0

- **Split layout**: session terminals open as editor tabs in a right-hand editor group, files stay on the left.
  *Move Open Sessions to the Right Editor Group* tidies existing ones.

## 0.3.0

- **Subagents**: a session lists the agents it spawned, with running/done/failed/stopped state and elapsed time;
  click one to open its transcript.
- **Context usage** bar on each session (tokens in use / context window).

## 0.2.0

- **The panel**: a view listing this workspace's sessions, grouped into open, running elsewhere, pinned and by day,
  with live status (Working, Needs you, Done), notifications and a status bar item.
- Rename, colour, pin, hide, fork; reopen the sessions that were open after a restart.

## 0.1.0

- A quick picker to resume several Claude Code sessions at once, each in its own named, coloured terminal.
