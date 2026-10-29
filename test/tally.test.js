const test = require('node:test');
const assert = require('node:assert/strict');
const t = require('../media/tally');

const run = { state: 'run' };
const done = { state: 'done' };
const s = (status, o = {}) => ({ id: Math.random().toString(36).slice(2), status, open: false, agents: [], ...o });

test('tally: working, needs you and running agents across all live sessions, here and elsewhere', () => {
  const out = t.tally([
    s('busy', { open: true, agents: [run, run, done] }),
    s('busy'), // another terminal
    s('busy', { hidden: true }), // hidden ones count too
    s('waiting', { open: true }),
    s('idle', { agents: [run] }), // its turn is over, its agents run on
    s('starting', { open: true }), // not working yet
    s('', { agents: [run] }), // not live: an agent that looked running doesn't count
    s(undefined),
  ]);
  assert.deepEqual(out, {
    working: 3,
    waiting: 1,
    agents: 3,
    here: { working: 1, waiting: 1, agents: 2 },
    elsewhere: { working: 2, waiting: 0, agents: 1 },
  });
});

test('tally: nothing live is all zeros', () => {
  const zero = { working: 0, waiting: 0, agents: 0 };
  assert.deepEqual(t.tally([]), { ...zero, here: zero, elsewhere: zero });
  assert.deepEqual(t.tally(undefined), { ...zero, here: zero, elsewhere: zero });
  assert.deepEqual(t.tally([s('idle'), s('', { agents: [done] })]), { ...zero, here: zero, elsewhere: zero });
});

test('matches: what each chip filters to', () => {
  assert.equal(t.matches('working', s('busy')), true);
  assert.equal(t.matches('working', s('starting')), false);
  assert.equal(t.matches('waiting', s('waiting')), true);
  assert.equal(t.matches('agents', s('idle', { agents: [done, run] })), true);
  assert.equal(t.matches('agents', s('busy', { agents: [done] })), false);
  assert.equal(t.matches('agents', s('', { agents: [run] })), false);
  assert.equal(t.matches('nonsense', s('busy')), false);
});

test('label: singular and plural', () => {
  assert.equal(t.label('working', 1), '1 working');
  assert.equal(t.label('working', 5), '5 working');
  assert.equal(t.label('waiting', 1), '1 needs you');
  assert.equal(t.label('waiting', 2), '2 need you');
  assert.equal(t.label('agents', 1), '1 agent running');
  assert.equal(t.label('agents', 4), '4 agents running');
});

test('tally: a running workflow row is not an agent, its agents are', () => {
  const out = t.tally([s('idle', { open: true, agents: [{ state: 'run', workflow: true }, run, run, done] })]);
  assert.equal(out.agents, 2);
});
