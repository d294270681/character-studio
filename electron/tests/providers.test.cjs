const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { ProviderManager, modelMetadata, endpoint, DEFAULT_MODEL } = require('../providers.cjs');
const { StudioKimiRunner } = require('../studio-kimi.cjs');
const { kimiExecutable } = require('../kimi.cjs');
const { findRoot } = require('../bridge.cjs');
const { terminalScript, TITLE } = require('../kimi-terminal.cjs');

const secureStorage = { isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from('encrypted:' + Buffer.from(value).toString('base64')),
  decryptString: value => Buffer.from(value.toString().slice(10), 'base64').toString() };
function make(options = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-providers-'));
  const bridge = { root: findRoot(), data, port: 18195, ensure: async () => {} };
  const manager = new ProviderManager(bridge, { secureStorage, catalogReader: () => ({ providers: [], models: [] }),
    connectionReader: () => ({}), metadataCatalog: { refresh: async () => {}, match: () => null }, ...options });
  return { data, bridge, manager };
}
const safe = value => {
  const serialized = JSON.stringify(value);
  assert.ok(!serialized.includes('test-secret-key'));
  assert.ok(!serialized.includes('encrypted_key'));
  assert.ok(!serialized.includes('custom_headers'));
};

test('endpoint validation strips operation suffixes and blocks credential URLs', () => {
  assert.equal(endpoint('https://example.com/v1/chat/completions'), 'https://example.com/v1');
  assert.equal(endpoint('http://127.0.0.1:8000/v1/models/'), 'http://127.0.0.1:8000/v1');
  for (const url of ['file:///etc/passwd', 'https://key:secret@example.com', 'https://example.com?key=secret', 'http://example.com'])
    assert.throws(() => endpoint(url));
});

test('model list metadata only reports declared capabilities and actual effort values', () => {
  const unknown = modelMetadata({ id: 'unknown' }, 'p');
  for (const field of ['tool_use', 'thinking_supported', 'image_in', 'max_context_size', 'max_output_tokens', 'support_efforts'])
    assert.equal(unknown[field], null);
  const known = modelMetadata({ id: 'known', tool_call: true, reasoning: true, support_efforts: ['low', 'max'],
    limit: { context: 65536, output: 8192 }, modalities: { input: ['text', 'image'] } }, 'p');
  assert.equal(known.tool_use, true); assert.equal(known.image_in, true);
  assert.deepEqual(known.support_efforts, ['low', 'max']); assert.equal(known.max_context_size, 65536);
  assert.equal(known.metadata_sources.max_output_tokens, 'endpoint');
});

test('custom credentials persist encrypted and never appear in returned state or runtime files', async () => {
  const { manager, data } = make();
  const saved = await manager.action('save', { label: 'Test', endpoint: 'https://example.com/v1', api_key: 'test-secret-key' });
  safe(saved); const id = saved.saved_provider_id;
  assert.ok(!fs.readFileSync(manager.file, 'utf8').includes('test-secret-key'));
  await manager.action('add_model', { provider_id: id, model: 'custom', values: { tool_use: true, max_context_size: 64000 } });
  const state = await manager.action('select', { provider_id: id, model_id: id + '/custom' });
  safe(state); assert.equal(state.selection.model, id + '/custom');
  const runtime = manager.prepareRuntime(state.selection, { value: null }, path.join(data, 'run'));
  assert.equal(runtime.env.CHARACTER_STUDIO_PROVIDER_KEY, 'test-secret-key');
  assert.ok(!fs.readFileSync(path.join(runtime.home, 'config.toml'), 'utf8').includes('test-secret-key'));
  assert.ok(fs.readFileSync(path.join(runtime.home, 'config.toml'), 'utf8').includes('api_key_env'));
  runtime.cleanup(); assert.ok(!fs.existsSync(path.join(runtime.home, 'config.toml')));
  const again = new ProviderManager(manager.bridge, { secureStorage, catalogReader: () => ({ models: [] }),
    metadataCatalog: { refresh: async () => {}, match: () => null } });
  assert.equal(again.connection(again.provider(id)).api_key, 'test-secret-key');
});

test('Windows protection unavailable rejects key save instead of writing plaintext', async () => {
  const { manager } = make({ secureStorage: { isEncryptionAvailable: () => false } });
  await assert.rejects(manager.action('save', { endpoint: 'https://example.com', api_key: 'test-secret-key' }), /密钥保护/);
  assert.ok(!fs.existsSync(manager.file));
});

test('import preserves existing DeepSeek max preference without revealing global credentials', async () => {
  const { manager, data } = make({ catalogReader: () => ({ thinking: { enabled: true, effort: 'high' }, models: [
    { id: DEFAULT_MODEL, provider: 'opencode-go', model: 'deepseek-v4.1-flash', tool_use: true,
      thinking_supported: true, support_efforts: ['low', 'high', 'max'], max_context_size: 100000 } ] }),
    connectionReader: () => ({ endpoint: 'https://opencode.ai/zen/go/v1', type: 'openai', api_key: 'test-secret-key' }) });
  const selected = { provider: 'opencode-go', model: DEFAULT_MODEL, thinking: 'on', effort: 'max' };
  fs.writeFileSync(path.join(data, 'kimi-selection.json'), JSON.stringify(selected));
  const state = manager.state(); safe(state); assert.deepEqual(state.selection, selected);
  assert.equal(state.providers.length, 1); assert.equal(state.providers[0].models.length, 1);
});

test('discovery, failed authorization, metadata refresh, manual overrides and busy guard', async () => {
  let status = 200, rows = [{ id: 'test-model', tool_call: true, limit: { context: 64000 } }], busy = false;
  const calls = [];
  const { manager } = make({ busy: () => busy, fetch: async (url, options) => {
    calls.push({ url, headers: options.headers, redirect: options.redirect });
    return new Response(JSON.stringify(status === 200 ? { data: rows } : { error: 'test-secret-key' }), { status });
  } });
  const id = (await manager.action('save', { endpoint: 'https://example.com/v1', api_key: 'test-secret-key' })).saved_provider_id;
  const state = await manager.action('discover', { provider_id: id }); safe(state);
  assert.equal(calls[0].url, 'https://example.com/v1/models'); assert.equal(calls[0].redirect, 'error');
  assert.equal(calls[0].headers.Authorization, 'Bearer test-secret-key');
  assert.equal(state.providers[0].models[0].enabled, false);
  await manager.action('update_model', { provider_id: id, model_id: id + '/test-model', values: { max_context_size: 32768, support_efforts: ['low', 'max'] } });
  rows = [{ id: 'test-model', limit: { context: 128000 } }];
  const refreshed = await manager.action('discover', { provider_id: id });
  assert.equal(refreshed.providers[0].models[0].max_context_size, 32768);
  assert.equal(refreshed.providers[0].models[0].metadata_sources.max_context_size, 'manual');
  status = 403;
  await assert.rejects(manager.action('discover', { provider_id: id }), error => /HTTP 403/.test(error.message) && !error.message.includes('test-secret-key'));
  busy = true; await assert.rejects(manager.action('remove', { provider_id: id }), /执行任务/);
  safe(await manager.action('list'));
});

test('terminal has a nonempty console title, selected model, cleanup and safely quoted paths', () => {
  const script = terminalScript({ executable: 'C:\\Kimi.exe', root: "F:\\test's studio", runtime: { home: 'F:\\runtime' }, model: 'studio/model' });
  assert.ok(script.includes(TITLE)); assert.ok(script.includes("--model 'studio/model'"));
  assert.ok(script.includes("test''s studio")); assert.ok(script.includes('finally'));
  assert.ok(!script.includes('start ""'));
});

test('Anthropic discovery and tool probe use Messages, x-api-key and the model input schema', async () => {
  const calls = [];
  const { manager } = make({ fetch: async (url, options) => {
    calls.push({ url, ...options });
    return new Response(JSON.stringify(url.endsWith('/models') ? { data: [{ id: 'anthropic-model', tool_use: true }] }
      : { id: 'test', type: 'message', content: [{ type: 'tool_use', name: 'studio_connection_check', input: { status: 'ok' } }] }));
  } });
  const id = (await manager.action('save', { endpoint: 'https://example.com/v1', protocol: 'anthropic', api_key: 'test-secret-key' })).saved_provider_id;
  await manager.action('discover', { provider_id: id });
  const result = await manager.action('probe', { provider_id: id, model_id: id + '/anthropic-model' });
  assert.equal(result.test.tool_call_verified, true); safe(result);
  assert.ok(calls[1].url.endsWith('/messages')); assert.equal(calls[1].headers['x-api-key'], 'test-secret-key');
  assert.equal(calls[1].headers['anthropic-version'], '2023-06-01');
  assert.equal(JSON.parse(calls[1].body).tools[0].input_schema.type, 'object');
});

test('real Kimi ACP executes a new provider with encrypted key, selected model and max thinking',
  { skip: !kimiExecutable(), timeout: 45000 }, async () => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let text = ''; for await (const part of request) text += part;
    const body = JSON.parse(text || '{}'); requests.push({ authorization: request.headers.authorization, ...body });
    const answer = { id: 'provider-test', model: body.model, object: 'chat.completion.chunk', choices: [{ index: 0,
      delta: { role: 'assistant', content: 'Connection verified.' }, finish_reason: null }] };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify(answer) + '\n\n');
    response.write('data: ' + JSON.stringify({ ...answer, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { manager, bridge } = make(); let runner, timer;
  bridge.request = async (method, route) => route === '/api/assistant/start'
    ? { id: 'provider-test-workflow', status: 'running', project_path: path.join(bridge.data, 'project.json') }
    : route === '/api/assistant/finish' ? { id: 'provider-test-workflow', status: 'complete' }
      : { jobs: [], assistant: { id: 'provider-test-workflow', status: 'running' } };
  try {
    const id = (await manager.action('save', { endpoint: 'http://127.0.0.1:' + server.address().port + '/v1', api_key: 'test-secret-key' })).saved_provider_id;
    await manager.action('add_model', { provider_id: id, model: 'probe-model', values: { tool_use: true, thinking_supported: true,
      support_efforts: ['low', 'max'], max_context_size: 64000 } });
    await manager.action('select', { provider_id: id, model_id: id + '/probe-model' });
    let finish; const done = new Promise(resolve => { finish = resolve; });
    runner = new StudioKimiRunner(bridge, packet => { if (packet.type === 'done') finish(packet); }, manager);
    await runner.setSelection({ provider: id, model: id + '/probe-model', thinking: 'on', effort: 'max' });
    await runner.start({ prompt: 'Reply Connection verified.', stages: ['original'] });
    timer = setTimeout(() => runner.cancel(), 20000);
    const result = await done; assert.equal(result.code, 0, result.error);
    assert.equal(requests.length, 1); assert.equal(requests[0].model, 'probe-model');
    assert.equal(requests[0].reasoning_effort, 'max'); assert.equal(requests[0].authorization, 'Bearer test-secret-key');
    assert.ok(requests[0].tools.some(tool => tool.function.name.includes('studio_generate')));
    const file = path.join(result.directory, 'kimi-home', 'config.toml'); assert.ok(!fs.existsSync(file));
  } finally { clearTimeout(timer); await runner?.cancel(); await new Promise(resolve => server.close(resolve)); }
});
