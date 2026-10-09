const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { ProviderManager } = require('../providers.cjs');
const { ModelMetadataCatalog } = require('../model-metadata.cjs');
const { StudioKimiRunner } = require('../studio-kimi.cjs');
const { kimiExecutable } = require('../kimi.cjs');
const { findRoot } = require('../bridge.cjs');

function sendResponses(response, model) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const answer = { id: 'resp-test', object: 'response', created_at: 1, status: 'in_progress', model, output: [] };
  const item = { id: 'msg-test', type: 'message', role: 'assistant', status: 'in_progress', content: [] };
  const part = { type: 'output_text', text: 'Verified.', annotations: [] };
  const events = [
    { type: 'response.created', response: answer },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { ...part, text: '' } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: part.text },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: part.text },
    { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part },
    { type: 'response.output_item.done', output_index: 0, item: { ...item, status: 'completed', content: [part] } },
    { type: 'response.completed', response: { ...answer, status: 'completed', output: [{ ...item, status: 'completed', content: [part] }],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
  ];
  events.forEach((event, i) => response.write('event: ' + event.type + '\ndata: ' + JSON.stringify({ sequence_number: i, ...event }) + '\n\n'));
  response.end();
}
function sendAnthropic(response, model) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const events = [
    { type: 'message_start', message: { id: 'msg-test', type: 'message', role: 'assistant', model, content: [], stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Verified.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ];
  events.forEach(event => response.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n')); response.end();
}

for (const kind of ['openai_responses', 'anthropic']) test('real Kimi automatically uses ' + kind + ', native max thinking and input limit',
  { skip: !kimiExecutable(), timeout: 30000 }, async () => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let text = ''; for await (const part of request) text += part;
    const body = JSON.parse(text || '{}'); requests.push({ url: request.url, body });
    if (kind === 'anthropic') sendAnthropic(response, body.model); else sendResponses(response, body.model);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = findRoot(), data = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-runtime-'));
  const base = 'http://127.0.0.1:' + server.address().port + '/v1';
  const registry = new ModelMetadataCatalog(data, { fetch: async () => new Response(JSON.stringify({ service: { id: 'service', api: base, models: {
    'probe-model': { id: 'probe-model', reasoning: true, tool_call: true,
      reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }], limit: { context: 64000, input: 50000, output: 8192 },
      provider: { npm: kind === 'anthropic' ? '@ai-sdk/anthropic' : '@ai-sdk/openai' } },
  } } })) });
  const bridge = { root, data, port: 18195, ensure: async () => {}, request: async (method, route) => route === '/api/assistant/start'
    ? { id: 'metadata-wire', status: 'running', project_path: path.join(data, 'project.json') }
    : route === '/api/assistant/finish' ? { id: 'metadata-wire', status: 'complete' } : { jobs: [], assistant: { id: 'metadata-wire', status: 'running' } } };
  const manager = new ProviderManager(bridge, { metadataCatalog: registry, catalogReader: () => ({ models: [] }),
    secureStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  let runner, timer;
  try {
    const saved = await manager.action('save', { endpoint: base, label: 'Local metadata', protocol: 'openai', api_key: 'local-test-key' });
    const id = saved.saved_provider_id;
    await manager.action('add_model', { provider_id: id, model: 'probe-model', values: { enabled: true } });
    const selected = await manager.action('select', { provider_id: id, model_id: id + '/probe-model', thinking: 'on', effort: 'max' });
    assert.equal(selected.providers[0].models[0].protocol, kind);
    let finish; const completed = new Promise(resolve => { finish = resolve; });
    runner = new StudioKimiRunner(bridge, packet => { if (packet.type === 'done') finish(packet); }, manager);
    const started = await runner.start({ prompt: 'Reply Verified.', stages: ['original'] });
    const config = fs.readFileSync(path.join(started.directory, 'kimi-home/config.toml'), 'utf8');
    assert.match(config, /"max_input_size" = 50000/);
    timer = setTimeout(() => runner.cancel(), 20000);
    const done = await completed; assert.equal(done.code, 0, done.error);
    assert.equal(new URL(requests[0].url, base).pathname, kind === 'anthropic' ? '/v1/messages' : '/v1/responses');
    const body = requests[0].body;
    assert.equal(kind === 'anthropic' ? body.output_config.effort : body.reasoning.effort, 'max');
    assert.ok(body.tools.some(tool => tool.name?.includes('studio_generate')));
    if (kind === 'anthropic') assert.ok(body.max_tokens <= 8192);
  } finally { clearTimeout(timer); await runner?.cancel(); await new Promise(resolve => server.close(resolve)); }
});
