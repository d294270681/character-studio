const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ModelMetadataCatalog, parseMetadata, enrichModel, inputBudget, sameEndpoint, CATALOG_URL } = require('../model-metadata.cjs');
const { ProviderManager, modelMetadata, DEFAULT_MODEL } = require('../providers.cjs');
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'studio-metadata-'));
const dataset = () => ({
  go: { id: 'go', api: 'https://example.com/go/v1', models: {
    'exact-model': { id: 'exact-model', canonical_model_id: 'lab/exact-model', name: 'Exact', reasoning: true, tool_call: true,
      reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }], limit: { context: 100000, input: 90000, output: 10000 },
      modalities: { input: ['text', 'image', 'audio', 'video'] }, provider: { npm: '@ai-sdk/anthropic' } },
    'responses-model': { id: 'responses-model', reasoning: true, tool_call: true, provider: { npm: '@ai-sdk/openai' },
      reasoning_options: [{ type: 'effort', values: ['none', 'low', 'max'] }], limit: { context: 64000, input: 50000, output: 14000 } },
  } },
  other: { id: 'other', api: 'https://example.com/other/v1', models: {
    'exact-model': { id: 'exact-model', canonical_model_id: 'lab/exact-model', tool_call: false, limit: { context: 8000, output: 2000 } } } },
  lab: { id: 'lab', api: 'https://lab.example.com', models: {
    'exact-model': { id: 'exact-model', reasoning: true, tool_call: true, limit: { context: 120000, output: 40000 } } } },
});
function catalog(data = dataset(), options = {}) {
  const result = new ModelMetadataCatalog(temp(), { fetch: async () => new Response(JSON.stringify(data)), ...options });
  return result;
}

test('reasoning option enums, separate token limits and declared media capabilities normalize', () => {
  const model = parseMetadata(dataset().go.models['exact-model']);
  assert.deepEqual(model.support_efforts, ['low', 'high', 'max']);
  assert.equal(model.max_input_tokens, 90000); assert.equal(model.max_output_tokens, 10000);
  assert.equal(model.video_in, true); assert.equal(model.audio_in, true); assert.equal(model.pdf_in, false);
  assert.equal(model.protocol, 'anthropic');
  const toggled = parseMetadata({ reasoning: true, reasoning_options: [{ type: 'toggle' }] });
  assert.deepEqual(toggled.support_efforts, []); assert.equal(toggled.can_disable_thinking, true);
  const unknown = parseMetadata({ id: 'guess-me' });
  assert.equal(unknown.support_efforts, null); assert.equal(unknown.image_in, null);
  const declared = parseMetadata({ reasoning: true, support_efforts: ['low', 'ultra'] });
  assert.deepEqual(declared.declared_efforts, ['low', 'ultra']); assert.deepEqual(declared.support_efforts, ['low']);
});

test('exact endpoint and model matching keeps separate gateways limits and rejects lookalikes', async () => {
  const registry = catalog(); await registry.refresh();
  const a = registry.match({ endpoint: 'https://example.com/go/v1' }, { model: 'exact-model' });
  const b = registry.match({ endpoint: 'https://example.com/other/v1' }, { model: 'exact-model' });
  assert.equal(a.metadata.max_context_size, 100000); assert.equal(b.metadata.max_context_size, 8000);
  assert.equal(a.kind, 'models_dev');
  assert.equal(registry.match({ endpoint: 'https://example.com/go/v1' }, { model: 'exact-model-fast' }), null);
  assert.ok(sameEndpoint('https://lab.example.com/v1', 'https://lab.example.com'));
  assert.ok(!sameEndpoint('https://example.com/go2/v1', 'https://example.com/go/v1'));
});

test('unknown proxy only gets an exact canonical manufacturer reference and no protocol guess', async () => {
  const registry = catalog(); await registry.refresh();
  const match = registry.match({ endpoint: 'https://proxy.example.com/v1' }, { model: 'exact-model' });
  assert.equal(match.kind, 'model_reference'); assert.equal(match.metadata.max_context_size, 120000);
  assert.equal(match.metadata.protocol, null);
  assert.equal(registry.match({ endpoint: 'https://proxy.example.com/v1' }, { model: 'exact-model-unknown' }), null);
});

test('endpoint declarations and global manual overrides outrank registry; app manual values survive', async () => {
  const registry = catalog(); await registry.refresh();
  const match = registry.match({ endpoint: 'https://example.com/go/v1' }, { model: 'exact-model' });
  const raw = modelMetadata({ id: 'exact-model', context_length: 50000 }, 'go');
  raw.max_output_tokens = 1000; raw.metadata_sources.max_output_tokens = 'kimi_override';
  raw.overrides = { tool_use: false };
  const enriched = enrichModel(raw, match);
  assert.equal(enriched.max_context_size, 50000); assert.equal(enriched.max_output_tokens, 1000);
  assert.equal(enriched.overrides.tool_use, false); assert.equal(enriched.image_in, true);
  assert.equal(enriched.metadata_sources.image_in, 'models_dev');
});

test('public catalog fetch has no provider credential and cached specs remain available offline', async () => {
  let now = Date.now(), calls = 0;
  const data = temp();
  const registry = new ModelMetadataCatalog(data, { now: () => now, fetch: async (url, options) => {
    calls++; assert.equal(url, CATALOG_URL);
    assert.deepEqual(Object.keys(options.headers).sort(), ['Accept', 'User-Agent']);
    return new Response(JSON.stringify(dataset()));
  } });
  await Promise.all([registry.refresh(), registry.refresh()]); assert.equal(calls, 1);
  await registry.refresh(); assert.equal(calls, 1);
  now += 25 * 60 * 60 * 1000;
  const offline = new ModelMetadataCatalog(data, { now: () => now, fetch: async () => { throw new Error('offline'); } });
  await offline.refresh(); assert.equal(offline.status.cached, true);
  assert.equal(offline.match({ endpoint: 'https://example.com/go/v1' }, { model: 'exact-model' }).metadata.max_input_tokens, 90000);
});

test('input budget reserves output once and never exceeds declared input or total context', () => {
  const result = inputBudget({ max_context_size: 1050000, max_input_tokens: 922000, max_output_tokens: 128000 });
  assert.equal(result.input_budget, 913808); assert.equal(result.runtime_input_limit, 922000);
  assert.equal(result.input_budget + result.reserved_output_tokens, result.runtime_input_limit);
  assert.equal(inputBudget({ max_context_size: 1000000, max_output_tokens: 384000 }).input_budget, 991808);
  assert.ok(inputBudget({ max_context_size: 100, max_input_tokens: 50 }).input_budget < 50);
});

test('opening catalog automatically enriches existing models, persists provenance and supports reset', async () => {
  const data = temp(); const registry = catalog(); await registry.refresh();
  const manager = new ProviderManager({ root: 'F:/godot', data, port: 18195 }, { metadataCatalog: registry,
    catalogReader: () => ({ models: [] }) });
  manager.profiles = [{ id: 'go', label: 'Go', endpoint: 'https://example.com/go/v1', protocol: 'openai', models: [
    { ...modelMetadata({ id: 'exact-model' }, 'go'), enabled: true } ] }];
  const state = await manager.action('list');
  const model = state.providers[0].models[0];
  assert.equal(model.max_input_tokens, 90000); assert.deepEqual(model.support_efforts, ['low', 'high', 'max']);
  assert.equal(model.protocol, 'anthropic'); assert.equal(model.metadata_sources.max_input_tokens, 'models_dev');
  await manager.action('update_model', { provider_id: 'go', model_id: 'go/exact-model', values: { max_input_tokens: 20000 } });
  await manager.autoMetadata(); assert.equal(manager.state().providers[0].models[0].max_input_tokens, 20000);
  const reset = await manager.action('reset_metadata', { provider_id: 'go', model_id: 'go/exact-model' });
  assert.equal(reset.providers[0].models[0].max_input_tokens, 90000);
  const runtime = manager.prepareRuntime({ provider: 'go', model: 'go/exact-model' }, { value: 'max' }, path.join(data, 'run'));
  const config = fs.readFileSync(path.join(runtime.home, 'config.toml'), 'utf8');
  assert.match(config, /"type" = "anthropic"/); assert.match(config, /"max_input_size" = 90000/);
  assert.match(config, /"max_output_size" = 10000/); assert.match(config, /"video_in"/);
  runtime.cleanup();
});

test('Responses model automatically probes the correct route and Responses tool schema', async () => {
  const registry = catalog(); await registry.refresh(); let actual;
  const manager = new ProviderManager({ root: 'F:/godot', data: temp(), port: 18195 }, { metadataCatalog: registry,
    catalogReader: () => ({ models: [] }), fetch: async (url, options) => {
      actual = { url, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ output: [{ type: 'function_call', name: 'studio_connection_check' }] }));
    } });
  manager.profiles = [{ id: 'go', label: 'Go', endpoint: 'https://example.com/go/v1', protocol: 'openai', models: [
    modelMetadata({ id: 'responses-model' }, 'go') ] }];
  await manager.autoMetadata();
  const response = await manager.action('probe', { provider_id: 'go', model_id: 'go/responses-model' });
  assert.equal(actual.url, 'https://example.com/go/v1/responses'); assert.equal(actual.body.tools[0].name, 'studio_connection_check');
  assert.equal(response.test.tool_call_verified, true);
});
