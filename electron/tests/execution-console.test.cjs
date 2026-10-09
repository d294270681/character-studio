const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ExecutionConsole, safeDetail } = require('../execution-console.cjs');
const moduleReady = import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.join(__dirname, '../src/lib/execution-log.js'), 'utf8')).toString('base64'));

test('tool details preserve useful parameters and exclude credentials and media', () => {
  const output = safeDetail({ input: { prompt: 'yellow dragon', width: 512, api_key: 'do-not-expose' },
    headers: { Authorization: 'Bearer secret-value' }, result: '{"token":"hidden-value","frames":124}',
    image_base64: 'large-image-payload', text: 'authorization=private-value password:another-secret' });
  const serialized = JSON.stringify(output);
  for (const secret of ['do-not-expose', 'secret-value', 'hidden-value', 'large-image-payload', 'private-value', 'another-secret'])
    assert.ok(!serialized.includes(secret));
  assert.equal(output.input.prompt, 'yellow dragon');
  assert.equal(output.input.width, 512);
  assert.equal(output.result.frames, 124);
});
test('assistant console persists bounded history, emits live rows and clears display', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-console-'));
  try {
    const packets = [], log = new ExecutionConsole(folder, packet => packets.push(packet), 2);
    for (const message of ['one', 'two', 'three']) log.add({ message, detail: { width: 512 } });
    assert.deepEqual(log.state().map(entry => entry.message), ['two', 'three']);
    assert.equal(packets.length, 3);
    assert.deepEqual(new ExecutionConsole(folder, null, 2).state().map(entry => entry.message), ['two', 'three']);
    log.clear();
    assert.equal(packets.at(-1).type, 'reset');
    assert.equal(new ExecutionConsole(folder, null, 2).state().length, 0);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
test('backend event replay handles rolling histories without duplicates and retains errors', async () => {
  const { jobEntries, mergeEntries, filterEntries } = await moduleReady;
  const job = { id: 'run', project_path: 'project', stage: 'video', created_at: '2026-10-08T20:00:00', status: 'running',
    events: [{ sequence: 1, event: 'submitted', prompt_id: 'prompt-42' }, { sequence: 2, event: 'progress', message: 'sampling 1/4' }] };
  let rows = mergeEntries([], jobEntries(job));
  job.events = [{ sequence: 2, event: 'progress', message: 'sampling 1/4' }, { sequence: 3, event: 'error', message: 'GPU memory exhausted' }];
  job.status = 'error';
  rows = mergeEntries(rows, jobEntries(job));
  assert.equal(rows.length, 5);
  assert.equal(rows.filter(row => row.message === 'sampling 1/4').length, 1);
  assert.equal(filterEntries(rows, 'error', 'GPU').length, 1);
  assert.equal(filterEntries(rows, 'kimi').length, 0);
});
test('console search finds actual tool parameters and isolates different projects', async () => {
  const { filterEntries, formatEntries } = await moduleReady;
  const rows = [{ id: 'a', source: 'kimi', level: 'info', message: 'studio_set_parameters', project_path: 'ours', detail: { width: 512, motion: 'walk_right' } },
    { id: 'b', source: 'generation', level: 'error', message: 'wrong project', project_path: 'other' }];
  assert.equal(filterEntries(rows, 'all', 'walk_right', 'ours').length, 1);
  assert.equal(filterEntries(rows, 'error', '', 'ours').length, 0);
  assert.ok(formatEntries(filterEntries(rows, 'kimi')).includes('512'));
});
