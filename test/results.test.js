const test = require('node:test');
const assert = require('node:assert/strict');
const results = require('../results');
const transcripts = require('../transcripts');

results.enable(true);

let n = 0;
const at = (i) => new Date(Date.UTC(2026, 9, 20, 10) + i * 1000).toISOString();
const line = (o) => JSON.stringify({ parentUuid: null, isSidechain: false, ...o, uuid: `x-${++n}`, timestamp: at(n) }) + '\n';
const call = (id, name, input) =>
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, toolUseResult, content = 'ok', isError = false) =>
  line({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError && { is_error: true }) }] },
    toolUseResult,
  });
const replay = (...blocks) => JSON.stringify({ type: 'api-request-blob', hash: 'h', message: { content: blocks } }) + '\n';
const text = (t) => [{ type: 'text', text: t }];
const brief = (s) => (results.forPayload(s) || []).map((r) => [r.kind, r.title, r.key]);

// Read as one chunk and one line at a time: a call and its result can land in different reads.
function scan(...lines) {
  const whole = results.scan(undefined, lines.join(''));
  const split = lines.reduce((s, l) => results.scan(s, l), undefined);
  assert.deepEqual(results.forPayload(split), results.forPayload(whole));
  return whole;
}

test('artifacts it published, once per link with the newest title; not ones it only opened, read or listed', () => {
  const A = 'https://claude.ai/artifact/AcmeReportAAAAAAAAAAAAA';
  const B = 'https://claude.ai/artifact/AcmeDeckBBBBBBBBBBBBBBB';
  const other = 'https://claude.ai/artifact/SomeoneElseCCCCCCCCCCCC';
  const s = scan(
    call('toolu_a1', 'Artifact', { file_path: '/home/dev/acme-web/report.html' }),
    result('toolu_a1', { url: A, path: '/home/dev/acme-web/report.html', artifact_id: 'id-a', title: 'Q3 report' }),
    call('toolu_a2', 'Artifact', { action: 'publish', file_path: '/home/dev/acme-web/report.html', url: A }),
    result('toolu_a2', { url: A, artifact_id: 'id-a', title: 'Q3 report, final', updated: true }),
    call('toolu_a3', 'Artifact', { title: 'Kickoff', type_url: 'https://claude.ai/artifact/SlidesTypeDDDDDDDDDDDD' }),
    result('toolu_a3', { url: B, title: 'Kickoff', type: 'Slides', created_from_type: true }),
    call('toolu_a4', 'Artifact', { action: 'open', url: other }),
    result('toolu_a4', { url: other, artifact_id: 'id-x', title: 'Not ours' }),
    call('toolu_a5', 'Artifact', { action: 'quickstart', intent: 'other' }),
    result('toolu_a5', { types: [{ type_url: 'https://claude.ai/artifact/TypeEEEEEEEEEEEEEEEEEE' }] }),
    call('toolu_a6', 'Artifact', { file_path: '/home/dev/acme-web/broken.html' }),
    result('toolu_a6', 'Nothing was done', '<tool_use_error>Nothing was done</tool_use_error>', true)
  );
  assert.deepEqual(brief(s), [
    ['artifact', 'Kickoff', B],
    ['artifact', 'Q3 report, final', A],
  ]);
});

test('Claude docs it created, not edits to one', () => {
  const D = 'https://claude.ai/code/artifact/0b1c2d3e-0000-4000-8000-000000000001';
  const ack = text(`{"verdict":"ok","frame":{"slug":"0b1c2d3e","url":"${D}","artifactUrl":"${D}"}}\n\nThe doc's viewer is at ${D}`);
  const s = scan(
    call('toolu_d1', 'mcp__claude_ai_Claude_Docs__batch', { container: { kind: 'project', create: { name: 'Launch plan' } } }),
    result('toolu_d1', ack, ack),
    call('toolu_d2', 'mcp__claude_ai_Claude_Docs__batch', { container: { kind: 'project', id: '0b1c2d3e' }, batch: [] }),
    result('toolu_d2', ack, ack)
  );
  assert.deepEqual(brief(s), [['doc', 'Launch plan', D]]);
});

test('pull and merge requests it opened, whatever the command around gh pr create', () => {
  const PR = 'https://github.com/acme/acme-web/pull/12';
  const mr = (iid, key) => text(`{"iid":"${iid}","${key}":"https://gitlab.com/acme/acme-web/-/merge_requests/${iid}"}`);
  const s = scan(
    call('toolu_p1', 'Bash', { command: 'cd /home/dev/acme-web && git push -u fork fix && gh pr create --title "Fix"' }),
    result('toolu_p1', { stdout: PR, stderr: '', gitOperation: { pr: { number: 12, url: PR, action: 'created' } } }, PR),
    call('toolu_p2', 'Bash', { command: 'grep -n "gh pr create" notes.md' }),
    result('toolu_p2', { stdout: '3: gh pr create', stderr: '' }, '3: gh pr create'),
    call('toolu_p3', 'Bash', { command: 'git push' }),
    result('toolu_p3', { stdout: '', stderr: '', gitOperation: { push: { branch: 'fix' } } }),
    call('toolu_m1', 'mcp__gitlab__create_merge_request', { project_id: 'acme/acme-web', title: 'Draft: Fix login' }),
    result('toolu_m1', mr(34, 'web_url'), mr(34, 'web_url')),
    call('toolu_m2', 'mcp__gitlab__create_merge_request', { project_id: 'acme/acme-web', title: 'Dark mode' }),
    result('toolu_m2', mr(35, 'url'), mr(35, 'url')),
    call('toolu_m3', 'mcp__gitlab__update_merge_request', { merge_request_iid: '35', title: 'Dark mode' }),
    result('toolu_m3', mr(35, 'web_url'), mr(35, 'web_url')),
    call('toolu_m4', 'mcp__gitlab__create_merge_request', { title: 'Conflict' }),
    result('toolu_m4', text('Error: 409'), text('Error: 409'), true),
    call('toolu_m5', 'mcp__gitlab__create_merge_request', { title: 'Odd' }),
    result('toolu_m5', text('Something went wrong'), text('Something went wrong'))
  );
  assert.deepEqual(brief(s), [
    ['mr', '!35 Dark mode', 'https://gitlab.com/acme/acme-web/-/merge_requests/35'],
    ['mr', '!34 Draft: Fix login', 'https://gitlab.com/acme/acme-web/-/merge_requests/34'],
    ['pr', '#12 acme/acme-web', PR],
  ]);
});

test('files it sent you, once each; plans you approved', () => {
  const pdf = '/home/dev/out/report.pdf';
  const xlsx = '/home/dev/out/data.xlsx';
  const s = scan(
    call('toolu_f1', 'SendUserFile', { files: [pdf, xlsx], caption: 'Q3', status: 'normal' }),
    result('toolu_f1', { caption: 'Q3', attachments: [{ path: pdf, size: 1 }, { path: xlsx, size: 1 }] }, '2 files delivered to user.'),
    call('toolu_f2', 'SendUserFile', { files: [pdf] }),
    result('toolu_f2', { attachments: [{ path: pdf, size: 2 }] }, '1 file delivered to user.'),
    call('toolu_x1', 'ExitPlanMode', { plan: '# Dark mode toggle\n\nSteps', planFilePath: '/home/dev/.claude/plans/dark.md' }),
    result('toolu_x1', { plan: '…', filePath: '/home/dev/.claude/plans/dark.md', isAgent: false }, 'User has approved your plan.'),
    call('toolu_x2', 'ExitPlanMode', { plan: '# Rejected', planFilePath: '/home/dev/.claude/plans/no.md' }),
    result('toolu_x2', 'Error: rejected', 'The user does not want to proceed', true),
    call('toolu_x3', 'ExitPlanMode', { plan: 'No heading here', planFilePath: '/home/dev/.claude/plans/other.md' }),
    result('toolu_x3', { plan: '…', filePath: '/home/dev/.claude/plans/other.md' }, 'User has approved your plan.')
  );
  assert.deepEqual(brief(s), [
    ['plan', 'other.md', '/home/dev/.claude/plans/other.md'],
    ['plan', 'Dark mode toggle', '/home/dev/.claude/plans/dark.md'],
    ['file', 'report.pdf', pdf],
    ['file', 'data.xlsx', xlsx],
  ]);
});

test('replayed requests, subagent lines and broken lines add nothing', () => {
  const A = 'https://claude.ai/artifact/AcmeReportAAAAAAAAAAAAA';
  const use = { type: 'tool_use', id: 'toolu_r1', name: 'Artifact', input: { file_path: '/home/dev/r.html' } };
  const done = { type: 'tool_result', tool_use_id: 'toolu_r1', content: `Published at ${A}` };
  const s = scan(
    call('toolu_r1', 'Artifact', { file_path: '/home/dev/r.html' }),
    replay(use, done),
    result('toolu_r1', { url: A, artifact_id: 'id-r', title: 'Report' }),
    replay({ ...use, id: 'toolu_r2' }, { ...done, tool_use_id: 'toolu_r2' }),
    line({ type: 'assistant', isSidechain: true, message: { content: [{ ...use, id: 'toolu_r3' }] } }),
    line({ type: 'user', isSidechain: true, message: { content: [{ ...done, tool_use_id: 'toolu_r3' }] }, toolUseResult: { url: A } }),
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_r4","name":"Artifact","input":{\n'
  );
  assert.deepEqual(brief(s), [['artifact', 'Report', A]]);
});

test('bounded: the 50 newest results, 20 calls waiting', () => {
  const lines = [];
  for (let i = 0; i < 60; i++) {
    lines.push(call(`toolu_c${i}`, 'SendUserFile', { files: [`/home/dev/out/f${i}.pdf`] }));
    lines.push(result(`toolu_c${i}`, { attachments: [{ path: `/home/dev/out/f${i}.pdf` }] }));
  }
  for (let i = 0; i < 30; i++) lines.push(call(`toolu_w${i}`, 'SendUserFile', { files: ['/home/dev/out/w.pdf'] }));
  const s = scan(...lines);
  const keys = brief(s).map((r) => r[2]);
  assert.equal(keys.length, 50);
  assert.equal(keys[0], '/home/dev/out/f59.pdf');
  assert.ok(!keys.includes('/home/dev/out/f9.pdf'));
  assert.equal(s.calls.size, 20);
});

test('forPayload: nothing when there are none, the same rows when nothing changed; get: only recorded keys', () => {
  assert.equal(results.forPayload(undefined), undefined);
  const s = scan(line({ type: 'user', message: { role: 'user', content: 'hello' } }));
  assert.equal(results.forPayload(s), undefined);
  const f = '/home/dev/out/a.pdf';
  results.scan(s, call('toolu_g1', 'SendUserFile', { files: [f] }) + result('toolu_g1', { attachments: [{ path: f }] }));
  const before = JSON.stringify(results.forPayload(s));
  results.scan(s, line({ type: 'user', message: { role: 'user', content: 'thanks' } }));
  assert.equal(JSON.stringify(results.forPayload(s)), before);
  assert.equal(results.get(s, f).kind, 'file');
  assert.equal(results.get(s, '/etc/passwd'), undefined);
  assert.equal(results.get(s, 42), undefined);
  assert.equal(results.get(undefined, f), undefined);
});

test('off: reads nothing', () => {
  results.enable(false);
  const f = '/home/dev/out/a.pdf';
  assert.equal(results.scan(undefined, call('toolu_o1', 'SendUserFile', { files: [f] }) + result('toolu_o1', { attachments: [{ path: f }] })), undefined);
  results.enable(true);
});

test('readChunk collects results across appended chunks', () => {
  const A = 'https://claude.ai/artifact/AcmeReportAAAAAAAAAAAAA';
  const info = {};
  transcripts.readChunk(info, call('toolu_i1', 'Artifact', { file_path: '/home/dev/r.html' }));
  assert.equal(results.forPayload(info.results), undefined);
  transcripts.readChunk(info, result('toolu_i1', { url: A, artifact_id: 'id-i', title: 'Report' }));
  assert.deepEqual(brief(info.results), [['artifact', 'Report', A]]);
});
