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
