const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const accounts = require('../accounts');

const home = path.resolve('/home/u');
const opts = { command: 'claude', env: {}, home };

test('resolve: no accounts configured means the one Claude Code uses, unlabelled', () => {
  const only = [{ label: '', dir: path.join(home, '.claude'), command: 'claude', color: '' }];
  assert.deepEqual(accounts.resolve(undefined, opts), only);
  assert.deepEqual(accounts.resolve([], opts), only);
  assert.deepEqual(accounts.resolve([], { ...opts, env: { CLAUDE_CONFIG_DIR: '/opt/claude' } }), [
    { label: '', dir: path.resolve('/opt/claude'), command: 'claude', color: '' },
  ]);
});

test('resolve: labelled folders, ~ expanded, the command falling back to claudeSessions.command', () => {
  const list = accounts.resolve(
    [
      { label: 'Work', configDir: '~/.claude', command: 'aclaude', color: 'blue' },
      { label: ' Personal ', configDir: '~/.claude-personal/', color: 'green' },
    ],
    opts
  );
  assert.deepEqual(list, [
    { label: 'Work', dir: path.join(home, '.claude'), command: 'aclaude', color: 'blue' },
    { label: 'Personal', dir: path.join(home, '.claude-personal'), command: 'claude', color: 'green' },
  ]);
});

test('resolve: skips entries without a label or an absolute or ~ folder, and repeats of a folder', () => {
  const list = accounts.resolve(
    [
      null,
      { configDir: '~/.claude' },
      { label: 'Relative', configDir: 'claude-dir' },
      { label: 'Blank', configDir: '  ' },
      { label: 'Work', configDir: '/opt/work', color: 'magenta', command: '  ' },
      { label: 'Again', configDir: '/opt/work/' },
    ],
    opts
  );
  assert.deepEqual(list, [{ label: 'Work', dir: path.resolve('/opt/work'), command: 'claude', color: '' }]);
});

test('ofFile: the account whose folder holds a transcript, not one whose name it merely starts with', () => {
  const list = accounts.resolve(
    [
      { label: 'Work', configDir: '~/.claude' },
      { label: 'Personal', configDir: '~/.claude-personal' },
    ],
    opts
  );
  const file = (dir) => path.join(home, dir, 'projects', '-home-u-app', 'abc.jsonl');
  assert.equal(accounts.ofFile(list, file('.claude')).label, 'Work');
  assert.equal(accounts.ofFile(list, file('.claude-personal')).label, 'Personal');
  assert.equal(accounts.ofFile(list, path.join(home, 'elsewhere', 'abc.jsonl')), undefined);
  assert.equal(accounts.ofFile(list, undefined), undefined);
});

test('terminalEnv: the folder in CLAUDE_CONFIG_DIR, but ~/.claude only with the variable unset', () => {
  const [work, personal] = accounts.resolve(
    [
      { label: 'Work', configDir: '~/.claude' },
      { label: 'Personal', configDir: '~/.claude-personal' },
    ],
    opts
  );
  assert.deepEqual(accounts.terminalEnv(personal, { env: {}, home }), { CLAUDE_CONFIG_DIR: path.join(home, '.claude-personal') });
  assert.equal(accounts.terminalEnv(work, { env: {}, home }), undefined);
  assert.deepEqual(accounts.terminalEnv(work, { env: { CLAUDE_CONFIG_DIR: '/opt/x' }, home }), { CLAUDE_CONFIG_DIR: null });
  const [unlabelled] = accounts.resolve([], { ...opts, env: { CLAUDE_CONFIG_DIR: '/opt/x' } });
  assert.equal(accounts.terminalEnv(unlabelled, { env: { CLAUDE_CONFIG_DIR: '/opt/x' }, home }), undefined); // as before
});

test('sameEnv: only on positive evidence; a terminal without env of its own has VS Code\'s', () => {
  assert.ok(accounts.sameEnv(undefined, undefined));
  assert.ok(accounts.sameEnv({ CLAUDE_CONFIG_DIR: null }, { CLAUDE_CONFIG_DIR: null }));
  // revived after a reload, or created before: no env, so it may well have VS Code's CLAUDE_CONFIG_DIR
  assert.ok(!accounts.sameEnv({}, { CLAUDE_CONFIG_DIR: null }));
  assert.ok(!accounts.sameEnv(undefined, { CLAUDE_CONFIG_DIR: null }));
  assert.ok(accounts.sameEnv({ CLAUDE_CONFIG_DIR: '/a' }, { CLAUDE_CONFIG_DIR: '/a' }));
  assert.ok(!accounts.sameEnv({ CLAUDE_CONFIG_DIR: '/a' }, undefined));
  assert.ok(!accounts.sameEnv(undefined, { CLAUDE_CONFIG_DIR: '/b' }));
});

test('display: ~ for the home directory', () => {
  assert.equal(accounts.display(path.join(home, '.claude'), home), path.join('~', '.claude'));
  assert.equal(accounts.display(home, home), '~');
  assert.equal(accounts.display(path.resolve('/home/user2/.claude'), home), path.resolve('/home/user2/.claude'));
});

// The extension's shell quoting, for the command tests.
const quote = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

test('resolve: two names for one folder (a symlink) are one account, the first; missing folders still work', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-'));
  try {
    fs.mkdirSync(path.join(root, 'real'));
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
    const list = accounts.resolve(
      [
        { label: 'A', configDir: path.join(root, 'link') },
        { label: 'B', configDir: path.join(root, 'real') },
        { label: 'C', configDir: path.join(root, 'missing') },
        { label: 'D', configDir: path.join(root, 'missing') },
      ],
      opts
    );
    assert.deepEqual(list.map((a) => a.label), ['A', 'C']);
    assert.equal(list[0].dir, path.join(root, 'link')); // as configured
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('isDefault: ~/.claude, also through a symlink', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  try {
    fs.mkdirSync(path.join(root, '.claude'));
    fs.symlinkSync(path.join(root, '.claude'), path.join(root, 'alias'));
    assert.ok(accounts.isDefault({ dir: path.join(root, '.claude') }, { home: root }));
    assert.ok(accounts.isDefault({ dir: path.join(root, 'alias') }, { home: root }));
    assert.ok(!accounts.isDefault({ dir: path.join(root, '.claude-work') }, { home: root }));
    assert.ok(!accounts.isDefault(undefined, { home: root }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('commandEnv: the typed command sets the account once there are several, or VS Code has the variable', () => {
  const [def, work] = accounts.resolve(
    [
      { label: 'Personal', configDir: '~/.claude' },
      { label: 'Work', configDir: '~/.claude-work' },
    ],
    opts
  );
  const o = { home, env: {}, platform: 'darwin' };
  assert.deepEqual(accounts.commandEnv(work, { ...o, several: true }), { CLAUDE_CONFIG_DIR: path.join(home, '.claude-work') });
  assert.deepEqual(accounts.commandEnv(def, { ...o, several: true }), { CLAUDE_CONFIG_DIR: null });
  // one account: only when VS Code's environment has CLAUDE_CONFIG_DIR
  assert.equal(accounts.commandEnv(work, o), undefined);
  assert.equal(accounts.commandEnv(def, o), undefined);
  assert.deepEqual(accounts.commandEnv(def, { ...o, env: { CLAUDE_CONFIG_DIR: '/x' } }), { CLAUDE_CONFIG_DIR: null });
  // no accounts configured, or Windows: never
  const [unlabelled] = accounts.resolve([], { ...opts, env: { CLAUDE_CONFIG_DIR: '/x' } });
  assert.equal(accounts.commandEnv(unlabelled, { ...o, several: true, env: { CLAUDE_CONFIG_DIR: '/x' } }), undefined);
  assert.equal(accounts.commandEnv(work, { ...o, several: true, platform: 'win32' }), undefined);
});

test('envPrefix: words in front of the command, quoted; nothing when there is nothing to set', () => {
  assert.equal(accounts.envPrefix(undefined, quote), '');
  assert.equal(accounts.envPrefix({}, quote), '');
  assert.equal(accounts.envPrefix({ CLAUDE_CONFIG_DIR: null }, quote), 'unset CLAUDE_CONFIG_DIR && ');
  assert.equal(accounts.envPrefix({ CLAUDE_CONFIG_DIR: '/home/u/.claude-work' }, quote), 'CLAUDE_CONFIG_DIR=/home/u/.claude-work ');
  assert.equal(accounts.envPrefix({ CLAUDE_CONFIG_DIR: "/home/u/My Claude's" }, quote), String.raw`CLAUDE_CONFIG_DIR='/home/u/My Claude'\''s' `);
  assert.equal(accounts.envPrefix({ CLAUDE_CONFIG_DIR: '/a/$(rm -rf x);`b`' }, quote), `CLAUDE_CONFIG_DIR='/a/$(rm -rf x);\`b\`' `);
});

test('pickTranscripts: one copy per session id across accounts, newest, or the running account\'s', () => {
  const list = accounts.resolve(
    [
      { label: 'A', configDir: '/acc/a' },
      { label: 'B', configDir: '/acc/b' },
    ],
    opts
  );
  const t = (acc, id, mtime) => ({ id, mtime, file: path.join(path.resolve('/acc', acc), 'projects', 'p', `${id}.jsonl`) });
  const infos = [t('a', 's1', 100), t('b', 's1', 200), t('a', 's2', 300), t('b', 's2', 300), t('b', 's3', 5)];
  const picked = accounts.pickTranscripts(infos, list);
  assert.equal(picked.get('s1').mtime, 200); // newer, in B
  assert.ok(picked.get('s2').file.startsWith(path.resolve('/acc/a'))); // a tie: the first account's
  assert.equal(picked.size, 3);
  // running on A: A's copy, though B's is newer
  const running = accounts.pickTranscripts(infos, list, (id) => (id === 's1' ? path.resolve('/acc/a') : undefined));
  assert.equal(running.get('s1').mtime, 100);
  // running on an account that has no copy: the newer one
  const nowhere = accounts.pickTranscripts(infos, list, () => '/acc/c');
  assert.equal(nowhere.get('s1').mtime, 200);
});

test('pickLive: one live record per session id, the most recently updated, the first on a tie', () => {
  const r = (sessionId, account, updatedAt, extra = {}) => ({ sessionId, pid: 7, status: 'idle', account, updatedAt, ...extra });
  const out = accounts.pickLive([r('s1', 'a', 10), r('s1', 'b', 20), r('s2', 'a', 5), r('s2', 'b', 5), r('s3', 'b', 1, { statusUpdatedAt: 50 })]);
  assert.deepEqual(out.map((d) => `${d.sessionId}:${d.account}`), ['s1:b', 's2:a', 's3:b']);
});
