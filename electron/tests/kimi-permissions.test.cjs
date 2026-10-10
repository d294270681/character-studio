const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { KimiRunner, kimiExecutable, permissionFor } = require('../kimi.cjs');

test('permission approval uses the offered one-time option and enforces the task mode', () => {
  const request = title => ({ toolCall: { title }, options: [
    { kind: 'allow_always', optionId: 'persist' }, { kind: 'allow_once', optionId: 'one-time-id' },
    { kind: 'reject_once', optionId: 'reject' },
  ] });
  assert.deepEqual(permissionFor('plan', request('mcp__character_studio__studio_get_state')),
    { outcome: { outcome: 'selected', optionId: 'one-time-id' } });
  assert.deepEqual(permissionFor('plan', request('mcp__character_studio__studio_generate')), { outcome: { outcome: 'cancelled' } });
  assert.deepEqual(permissionFor('execute', request('mcp__character_studio__studio_generate')),
    { outcome: { outcome: 'selected', optionId: 'one-time-id' } });
  for (const mode of ['plan', 'execute']) {
    for (const tool of ['Shell', 'WriteFile', 'DeleteFile', 'mcp__evil__studio_generate', 'studio_generate']) assert.deepEqual(permissionFor(mode, request(tool)), { outcome: { outcome: 'cancelled' } });
  }
});

test('real Kimi ACP preserves custom agent tool allowlists on the model request', { skip: !kimiExecutable(), timeout: 60000 }, async () => {
  const { app, verification } = require('./test-paths.cjs').testPaths();
  const folder = fs.mkdtempSync(path.join(verification, 'kimi-profile-'));
  const fakeHome = path.join(folder, 'home');
  fs.mkdirSync(fakeHome);
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body += part;
    const payload = JSON.parse(body || '{}');
    requests.push({ model: payload.model, tool_names: (payload.tools || []).map(tool => tool.function?.name || tool.name) });
    const answer = { id: 'profile-probe', object: 'chat.completion', model: payload.model, created: Math.floor(Date.now() / 1000),
      choices: [{ index: 0, message: { role: 'assistant', content: '工具范围验证完成。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    if (payload.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: ' + JSON.stringify({ ...answer, object: 'chat.completion.chunk', choices: [{ index: 0, delta: answer.choices[0].message, finish_reason: null }] }) + '\n\n');
      response.write('data: ' + JSON.stringify({ ...answer, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
      response.end('data: [DONE]\n\n');
    } else { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(answer)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/v1';
  const config = 'default_model = "mock/default"\n[thinking]\nenabled = true\neffort = "high"\n' +
    '[models."mock/default"]\nprovider = "mock"\nmodel = "mock-default"\nmax_context_size = 64000\ncapabilities = ["thinking", "tool_use"]\nsupport_efforts = ["low", "high"]\ndefault_effort = "high"\n' +
    '[models."mock/boolean"]\nprovider = "mock"\nmodel = "mock-boolean"\nmax_context_size = 64000\ncapabilities = ["thinking", "tool_use"]\n' +
    '[providers.mock]\ntype = "openai"\nbase_url = "' + base + '"\napi_key = "local-qa-placeholder"\n';
  const configFile = path.join(fakeHome, 'config.toml');
  fs.writeFileSync(configFile, config);
  fs.writeFileSync(path.join(fakeHome, 'mcp.json'), JSON.stringify({ mcpServers: { character_studio: {
    command: process.execPath, args: [path.join(app, 'electron', 'mcp.cjs')],
    env: { CHARACTER_STUDIO_ROOT: app, CHARACTER_STUDIO_DATA: path.join(folder, 'data'), CHARACTER_STUDIO_PORT: '18195' },
  } } }));
  const previousHome = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = fakeHome;
  const checks = [];
  let runner;
  try {
    for (const scenario of [{ mode: 'plan', model: 'mock/default', effort: 'low' }, { mode: 'execute', model: 'mock/default', effort: 'low' },
      { mode: 'plan', model: 'mock/boolean', effort: 'default' }]) {
      const { mode, model, effort } = scenario;
      let resolve;
      const complete = new Promise(done => { resolve = done; });
      runner = new KimiRunner({ root: app, data: path.join(folder, 'data'), port: 18195, ensure: async () => {} }, packet => { if (packet.type === 'done') resolve(packet); });
      const before = requests.length;
      const start = await runner.start({ mode, prompt: '只回复“工具范围验证完成”。', selection: { provider: 'mock', model, thinking: 'on', effort } });
      const timer = setTimeout(() => runner.cancel(), 20000);
      const done = await complete;
      clearTimeout(timer);
      assert.equal(done.code, 0, done.error);
      if (model === 'mock/boolean') assert.equal(start.resolved.thinking_value, 'on');
      const actual = requests[before];
      assert.ok(actual, 'The fake model endpoint did not receive a request');
      assert.ok(actual.tool_names.some(name => name.includes('studio_get_state')));
      assert.ok(actual.tool_names.some(name => name.includes('studio_inspect_asset')));
      if (mode === 'plan') {
        assert.ok(!actual.tool_names.some(name => name.includes('studio_generate')), JSON.stringify(actual.tool_names));
        assert.ok(!actual.tool_names.some(name => name.includes('studio_set_parameters')));
      } else assert.ok(actual.tool_names.some(name => name.includes('studio_generate')));
      for (const forbidden of ['Shell', 'WriteFile', 'SubAgent', 'Task', 'StrReplaceFile', 'Bash', 'Edit', 'Write', 'Agent', 'AgentSwarm', 'CronCreate']) {
        assert.ok(!actual.tool_names.some(name => name === forbidden), mode + ' exposed ' + forbidden);
      }
      checks.push({ mode, passed: true, ...actual });
    }
    assert.equal(fs.readFileSync(configFile, 'utf8'), config, 'ACP task settings changed the original config');
    fs.writeFileSync(path.join(verification, 'kimi-profile-verification.json'),
      JSON.stringify({ passed: true, config_preserved: true, checked_at: new Date().toISOString(), checks }, null, 2) + '\n');
  } finally {
    runner?.cancel();
    if (previousHome === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = previousHome;
    await new Promise(resolve => server.close(resolve));
  }
});
