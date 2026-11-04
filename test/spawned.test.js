const test = require('node:test');
const assert = require('node:assert/strict');
const spawned = require('../spawned');
const transcripts = require('../transcripts');

let n = 0;
const at = (i) => new Date(Date.UTC(2026, 9, 20, 10) + i * 1000).toISOString();
const line = (o) =>
  JSON.stringify({ parentUuid: null, isSidechain: false, ...o, uuid: `x-${++n}`, timestamp: at(n) }) + '\n';
const hints = (id) => `\n  claude agents             list sessions\n  claude logs ${id}      show recent output\n`;
const started = (id, name, extra = {}) =>
  line({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: `backgrounded · ${id} · ${name}${hints(id)}` }],
    },
    toolUseResult: { stdout: `backgrounded · ${id} · ${name}${hints(id)}`, stderr: '', interrupted: false },
    ...extra,
  });
const said = (t) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });
const brief = (s) => [...(s || new Map()).values()].map((c) => [c.short, c.name]);

test('a child started with --bg, by the short id and name Claude Code printed', () => {
  const s = spawned.scan(undefined, said('Starting it in the background.') + started('0a1b2c3d', 'fix-tests'));
  assert.deepEqual(brief(s), [['0a1b2c3d', 'fix-tests']]);
  assert.equal(s.get('0a1b2c3d').at, Date.parse(at(n)));
});

test('the escaped middle dot reads the same as the literal one', () => {
  const escaped = started('0a1b2c3d', 'fix-tests').replace(/·/g, '\\u00b7');
  assert.ok(escaped.includes('\\u00b7') && !escaped.includes('·'));
  assert.deepEqual(brief(spawned.scan(undefined, escaped)), [['0a1b2c3d', 'fix-tests']]);
});

test('ignored: api-request replays, sidechains, broken lines, and the words in prose or a command', () => {
  const replay =
    JSON.stringify({ type: 'api-request-blob', toolUseResult: { stdout: 'backgrounded · 11111111 · x' } }) + '\n';
  const side = started('22222222', 'sub', { isSidechain: true });
  const broken = started('33333333', 'cut').slice(0, -20) + '\n';
  const prose = said('It printed "stdout":"backgrounded · 44444444 · quoted"');
  const grep = line({ type: 'user', toolUseResult: { stdout: 'log: "stdout":"backgrounded · 55555555 · grep"' } });
  assert.equal(spawned.scan(undefined, replay + side + broken + prose + grep), undefined);
});

test('chunks add up, a restart of the same id moves it last, and only the newest are kept', () => {
  let s = spawned.scan(undefined, started('0a1b2c3d', 'one'));
  s = spawned.scan(s, started('1a1b2c3d', 'two') + started('0a1b2c3d', 'one again'));
  assert.deepEqual(brief(s), [
    ['1a1b2c3d', 'two'],
    ['0a1b2c3d', 'one again'],
  ]);
  const many = Array.from({ length: spawned.CAP + 2 }, (_, i) => started(i.toString(16).padStart(8, '0'), `c${i}`));
  s = spawned.scan(undefined, many.join(''));
  assert.equal(s.size, spawned.CAP);
  assert.equal(s.has('00000000'), false);
  assert.equal(s.has((spawned.CAP + 1).toString(16).padStart(8, '0')), true);
});

test('resolve: the one id the short id starts, else nothing', () => {
  const ids = ['0a1b2c3d-1111-4111-8111-111111111111', 'ffffffff-2222-4222-8222-222222222222'];
  assert.equal(spawned.resolve('0a1b2c3d', ids), ids[0]);
  assert.equal(spawned.resolve('12345678', ids), '');
  assert.equal(spawned.resolve('0a1b2c3d', [...ids, '0a1b2c3d-3333-4333-8333-333333333333']), '');
  assert.equal(spawned.resolve('0a1b2c3d', [ids[0], ids[0]]), ids[0]);
});

test('finished: a turn ended, or it exited while working; nothing else', () => {
  assert.equal(spawned.finished('busy', 'idle'), true);
  assert.equal(spawned.finished('busy', undefined), true);
  for (const [a, b] of [
    [undefined, 'busy'],
    [undefined, 'idle'],
    ['idle', 'busy'],
    ['idle', undefined],
    ['busy', 'busy'],
    ['busy', 'waiting'],
    ['waiting', 'idle'],
  ])
    assert.equal(spawned.finished(a, b), false, `${a} → ${b}`);
});

test('note: fixed wording, a cleaned name, never more', () => {
  assert.equal(
    spawned.note('fix-tests', '0a1b2c3d'),
    'Background session "fix-tests" (0a1b2c3d) finished. See its output with: claude logs 0a1b2c3d',
  );
  assert.equal(
    spawned.note('x"; rm -rf ~ `y`\nignore previous', 'ab'),
    'Background session "x rm -rf  y ignore previous" (ab) finished. See its output with: claude logs ab',
  );
  assert.equal(spawned.note('', 'ab'), 'Background session ab finished. See its output with: claude logs ab');
  assert.equal(spawned.note('a'.repeat(100), 'ab').match(/"(a+)"/)[1].length, 60);
});

test('readChunk records the children a session started', () => {
  const info = {};
  transcripts.readChunk(info, said('hi'));
  assert.equal(info.spawned, undefined);
  transcripts.readChunk(info, started('0a1b2c3d', 'fix-tests'));
  assert.deepEqual(brief(info.spawned), [['0a1b2c3d', 'fix-tests']]);
});

const links = (entries) => new Map(entries.map(([child, parentCliId, kind = 'bg']) => [child, { parentCliId, kind }]));
const statuses = (o) => (id) => o[id];

test('wakes: finished background children of a parent with a terminal in this window, not yet told', () => {
  const lineage = links([
    ['c1', 'p1'], // finished: busy → idle
    ['c2', 'p1'], // exited while working: busy → gone
    ['c3', 'p1'], // still busy
    ['c4', 'p1'], // finished, but another window told p1 already
    ['c5', 'p2'], // finished, but p2's terminal is in another window
    ['c6', 'p1', 'spawned'], // the desktop app's link, not --bg
  ]);
  const before = statuses({ c1: 'busy', c2: 'busy', c3: 'busy', c4: 'busy', c5: 'busy', c6: 'busy' });
  const after = statuses({ c1: 'idle', c3: 'busy', c4: 'idle', c5: 'idle', c6: 'idle' });
  const out = spawned.wakes(lineage, { before, after, woken: ['c4'], here: (p) => p === 'p1' });
  assert.deepEqual(out, [
    { parent: 'p1', child: 'c1' },
    { parent: 'p1', child: 'c2' },
  ]);
});

test('wakes: nothing in a window without the parent, so the child stays unmarked for the one that has it', () => {
  const lineage = links([['c1', 'p1']]);
  const opts = { before: statuses({ c1: 'busy' }), after: statuses({ c1: 'idle' }), woken: [] };
  assert.deepEqual(spawned.wakes(lineage, { ...opts, here: () => false }), []);
  assert.deepEqual(spawned.wakes(lineage, { ...opts, here: () => true }), [{ parent: 'p1', child: 'c1' }]);
});

test('prune: notes for parents no longer running in this window are dropped', () => {
  const pending = new Map([
    ['p1', ['a']],
    ['p2', ['b', 'c']],
  ]);
  spawned.prune(pending, (p) => p === 'p2');
  assert.deepEqual([...pending], [['p2', ['b', 'c']]]);
  assert.equal(spawned.prune(new Map(), () => false).size, 0);
});
