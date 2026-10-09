const test = require('node:test');
const assert = require('node:assert/strict');
const { studioCatalog, studioSelection, adoptedSelection, MODEL_ID, PROVIDER_ID, STUDIO_DEFAULT } = require('../studio-kimi.cjs');

const rawCatalog = () => ({ default_model: 'other/opus', config_path: 'config.toml', thinking: { enabled: true, effort: 'high' },
  providers: [{ id: PROVIDER_ID, label: 'OpenCode Go', model_count: 35 }, { id: 'other', model_count: 1 }],
  models: [{ id: MODEL_ID, provider: PROVIDER_ID, model: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash',
    thinking_supported: true, can_disable_thinking: true, support_efforts: ['low', 'high', 'max'], default_effort: 'high', tool_use: true },
    { id: 'opencode-go/deepseek-v4-flash', provider: PROVIDER_ID }, { id: 'other/opus', provider: 'other' }] });

test('studio catalog exposes one provider and one model without changing global catalog', () => {
  const raw = rawCatalog();
  const before = JSON.stringify(raw);
  const catalog = studioCatalog(raw);
  assert.equal(catalog.fixed_model, true);
  assert.equal(catalog.default_model, MODEL_ID);
  assert.deepEqual(catalog.models.map(model => model.id), [MODEL_ID]);
  assert.deepEqual(catalog.providers.map(provider => [provider.id, provider.model_count]), [[PROVIDER_ID, 1]]);
  assert.equal(JSON.stringify(raw), before);
});

test('missing required model reports an error instead of exposing another provider', () => {
  const raw = rawCatalog();
  raw.models = raw.models.filter(model => model.id !== MODEL_ID);
  assert.throws(() => studioCatalog(raw), /需要 Kimi 配置中的/);
});

test('old or empty preferences migrate to the tested low-effort model', () => {
  const catalog = studioCatalog(rawCatalog());
  assert.deepEqual(adoptedSelection(catalog, { provider: 'other', model: 'other/opus', thinking: 'on', effort: 'medium' }), STUDIO_DEFAULT);
  assert.deepEqual(adoptedSelection(catalog, { provider: '', model: '', thinking: 'default', effort: 'default' }), STUDIO_DEFAULT);
});

test('supported DeepSeek preferences are preserved and invalid saved efforts reset safely', () => {
  const catalog = studioCatalog(rawCatalog());
  const max = { ...STUDIO_DEFAULT, effort: 'max' };
  assert.deepEqual(adoptedSelection(catalog, max), max);
  assert.deepEqual(adoptedSelection(catalog, { ...max, effort: 'medium' }), STUDIO_DEFAULT);
  const off = { ...STUDIO_DEFAULT, thinking: 'off', effort: 'default' };
  assert.deepEqual(adoptedSelection(catalog, off), off);
});

test('direct invocation cannot select a removed model or fall back to global default', () => {
  const catalog = studioCatalog(rawCatalog());
  assert.throws(() => studioSelection(catalog, { ...STUDIO_DEFAULT, model: 'opencode-go/deepseek-v4-flash' }), /只使用/);
  assert.throws(() => studioSelection(catalog, { provider: 'other', model: 'other/opus' }), /只使用/);
  const selection = studioSelection(catalog, {});
  assert.equal(selection.provider, PROVIDER_ID);
  assert.equal(selection.model, MODEL_ID);
});

test('unsupported requested effort is rejected rather than silently changed', () => {
  assert.throws(() => studioSelection(studioCatalog(rawCatalog()), { ...STUDIO_DEFAULT, effort: 'medium' }), /不支持等级/);
});
