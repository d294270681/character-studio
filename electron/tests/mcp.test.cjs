const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { tools, callTool, compactState } = require('../mcp.cjs');

test('generation submits one stage without selecting candidates or chaining later jobs', async () => {
  const calls = [];
  const bridge = { request: async (...args) => { calls.push(args); return { id: 'one-job', stage: 'style', status: 'starting', assets: [] }; } };
  const result = await callTool(bridge, 'studio_generate', { stage: 'style', parameters: { count: 2, quality: 0 } });
  assert.equal(result.job_id, 'one-job');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['POST', '/api/jobs', { stage: 'style', parameters: { count: 2, quality: 0 }, source: 'kimi' }]);
});

test('asset inspection delivers native image blocks and retains metadata', async () => {
  const bridge = { request: async (method, route, body) => {
    assert.equal(route, '/api/assets/inspect');
    assert.equal(body.view, 'contact_sheet');
    return { record: { id: 'video1' }, width: 1024, height: 768, image_base64: 'AA==', mime_type: 'image/png', note: 'sampled frames' };
  } };
  const result = await callTool(bridge, 'studio_inspect_asset', { stage: 'video', asset_id: 'video1', view: 'contact_sheet' });
  assert.deepEqual(result.content[1], { type: 'image', data: 'AA==', mimeType: 'image/png' });
  const info = JSON.parse(result.content[0].text);
  assert.equal(info.record.id, 'video1');
  assert.equal(info.note, 'sampled frames');
  assert.ok(!('image_base64' in info));
});

test('workflow identity is attached to parameter writes, generation, selection and cancellation', async () => {
  const calls = [];
  const bridge = { request: async (...args) => { calls.push(args); return { id: 'job', status: 'starting' }; } };
  await callTool(bridge, 'studio_set_parameters', { stage: 'style', values: { prompt: '像素全身白底' } }, 'our-flow');
  await callTool(bridge, 'studio_generate', { stage: 'style' }, 'our-flow');
  await callTool(bridge, 'studio_select_asset', { stage: 'style', asset_id: 'new-asset' }, 'our-flow');
  await callTool(bridge, 'studio_cancel_job', { job_id: 'job' }, 'our-flow');
  assert.ok(calls.every(call => call[2].workflow_id === 'our-flow'));
  assert.equal(calls[1][2].source, 'kimi');
  assert.equal(calls[3][1], '/api/jobs/job/cancel');
});

test('scoped assistant cannot switch projects, import inputs or export outside its requested steps', async () => {
  const bridge = { request: async () => { throw new Error('must not reach the service'); } };
  for (const name of ['studio_create_project', 'studio_open_project', 'studio_import_asset', 'studio_export_godot']) {
    await assert.rejects(callTool(bridge, name, {}, 'our-flow'), /当前执行工作流不支持/);
  }
});

test('cancellation identifies only the requested job', async () => {
  const bridge = { request: async (method, route, body) => {
    assert.equal(method, 'POST');
    assert.equal(route, '/api/jobs/the-job/cancel');
    assert.deepEqual(body, {});
    return { id: 'the-job', status: 'cancelling' };
  } };
  assert.equal((await callTool(bridge, 'studio_cancel_job', { job_id: 'the-job' })).status, 'cancelling');
});

test('completed status returns immediately even when a wait was requested', async () => {
  const start = Date.now();
  const result = await callTool({ request: async () => ({ id: 'done', status: 'complete' }) },
    'studio_job_status', { job_id: 'done', wait_seconds: 20 });
  assert.equal(result.status, 'complete');
  assert.ok(Date.now() - start < 500);
});

test('state summaries bound history without changing selected ids or source data', () => {
  const assets = Array.from({ length: 25 }, (_, id) => ({ id: String(id), path: 'asset.png', history: 'large', prompt: 'long' }));
  const source = { project: { name: '角色', path: 'project.json', selected: { original: '3' }, assets: { original: assets } },
    settings: { original: { quality: 1 } }, jobs: [{ id: 'j', status: 'complete', events: [{ large: true }] }] };
  const result = compactState(source);
  assert.equal(result.project.assets.original.length, 16);
  assert.equal(result.project.selected.original, '3');
  assert.equal(result.project.assets.original[0].id, '9');
  assert.ok(!('events' in result.jobs[0]));
  assert.equal(source.project.assets.original.length, 25);
});

test('stdio MCP completes handshake and reports tools with no diagnostic stdout', async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp.cjs')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const messages = new Map(), waiting = new Map();
  lines.on('line', line => {
    const message = JSON.parse(line);
    if (waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
    else messages.set(message.id, message);
  });
  const request = (id, method, params = {}) => {
    const response = new Promise(resolve => waiting.set(id, resolve));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return response;
  };
  try {
    const init = await request(1, 'initialize', { protocolVersion: '2025-03-26' });
    assert.equal(init.result.protocolVersion, '2025-03-26');
    assert.equal(init.result.serverInfo.name, 'character-studio');
    const list = await request(2, 'tools/list');
    assert.equal(list.result.tools.length, tools.length);
    assert.equal(new Set(list.result.tools.map(tool => tool.name)).size, tools.length);
    assert.equal(list.result.tools.find(tool => tool.name === 'studio_get_state').annotations.readOnlyHint, true);
    assert.equal(list.result.tools.find(tool => tool.name === 'studio_generate').annotations.readOnlyHint, false);
    const unknown = await request(3, 'unsupported');
    assert.equal(unknown.error.code, -32601);
    assert.deepEqual((await request(4, 'ping')).result, {});
  } finally { child.stdin.end(); child.kill(); }
});
