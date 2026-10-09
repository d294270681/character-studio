const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  runCatalog, resolveSelection, planThinking, buildTerminalLaunch, normalizeSelection,
  readSelection, saveSelection, selectionPath, kimiConfigPath, DEFAULT_SELECTION,
} = require('../kimi-config.cjs');

// The catalog script lives at <root>/tools/character-studio/kimi_config.py.
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'kimi');
const FULL = path.join(FIXTURES, 'config-full.toml');
const UNKNOWN = path.join(FIXTURES, 'config-unknown-caps.toml');
const BROKEN = path.join(FIXTURES, 'config-broken.toml');

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-config-test-'));
}

test('catalog groups models under their provider and counts them', async () => {
  const catalog = await runCatalog(ROOT, FULL);
  assert.equal(catalog.default_model, 'alpha/opus');
  assert.deepEqual(catalog.providers.map(provider => provider.id), ['alpha', 'beta', 'managed:gamma']);
  assert.equal(catalog.providers.find(provider => provider.id === 'alpha').model_count, 3);
  assert.equal(catalog.providers.find(provider => provider.id === 'beta').type, 'kimi');
  assert.equal(catalog.providers.find(provider => provider.id === 'managed:gamma').label, 'gamma');
  assert.deepEqual(catalog.models.map(model => model.provider).sort(), ['alpha', 'alpha', 'alpha', 'beta', 'managed:gamma']);
  assert.equal(catalog.thinking.enabled, true);
  assert.equal(catalog.thinking.effort, 'high');
});

test('model overrides win over the top-level metadata', async () => {
  const catalog = await runCatalog(ROOT, FULL);
  const model = catalog.models.find(item => item.id === 'gamma/override');
  assert.equal(model.label, 'Gamma Overridden');
  assert.deepEqual(model.support_efforts, ['low', 'high']);
  assert.equal(model.default_effort, 'low');
  assert.equal(model.thinking_supported, true);
  assert.equal(model.can_disable_thinking, true);
});

test('catalog exposes capability flags used by the UI', async () => {
  const catalog = await runCatalog(ROOT, FULL);
  const opus = catalog.models.find(item => item.id === 'alpha/opus');
  assert.equal(opus.tool_use, true);
  assert.equal(opus.image_in, true);
  assert.equal(opus.video_in, false);
  assert.equal(opus.always_thinking, false);
  const always = catalog.models.find(item => item.id === 'alpha/always');
  assert.equal(always.always_thinking, true);
  assert.equal(always.can_disable_thinking, false);
  const k3 = catalog.models.find(item => item.id === 'beta/k3');
  assert.equal(k3.video_in, true);
  assert.equal(k3.image_in, false);
});

test('a model without a declared capabilities list reports unknown, not unsupported', async () => {
  const catalog = await runCatalog(ROOT, UNKNOWN);
  const model = catalog.models[0];
  assert.equal(model.capabilities, null);
  assert.equal(model.tool_use, null);
  assert.equal(model.image_in, null);
  assert.equal(model.video_in, null);
  assert.equal(model.thinking_supported, null);
  assert.equal(model.always_thinking, null);
  assert.equal(model.can_disable_thinking, null);
  // Unknown means "let the CLI decide", so the selection is not blocked.
  assert.doesNotThrow(() => resolveSelection(catalog, { provider: 'solo', model: 'solo/plain', thinking: 'on', effort: 'default' }));
});

test('catalog never carries credentials, endpoints, or header tables', async () => {
  const catalog = await runCatalog(ROOT, FULL);
  const serialized = JSON.stringify(catalog);
  for (const needle of ['DUMMY-ALPHA-KEY', 'DUMMY-BETA-KEY', 'DUMMY-HEADER-VALUE', 'DUMMY-SOLO-KEY',
    'api_key', 'base_url', 'custom_headers', 'oauth', '127.0.0.1']) {
    assert.equal(serialized.includes(needle), false, 'catalog leaked ' + needle);
  }
  for (const provider of catalog.providers) {
    assert.deepEqual(Object.keys(provider).sort(), ['id', 'label', 'model_count', 'type']);
  }
});

test('the live machine config also stays free of credential material', async t => {
  const configPath = kimiConfigPath();
  if (!fs.existsSync(configPath)) {
    t.skip('no local Kimi config on this machine');
    return;
  }
  const catalog = await runCatalog(ROOT, configPath);
  const serialized = JSON.stringify(catalog);
  for (const needle of ['api_key', 'base_url', 'custom_headers', 'oauth', 'sk-', 'oc_sk', 'Bearer']) {
    assert.equal(serialized.includes(needle), false, 'live catalog leaked ' + needle);
  }
  assert.ok(catalog.models.length > 0);
  assert.ok(catalog.providers.length > 0);
});

test('a model that disappeared from the config is rejected instead of silently swapped', async () => {
  const catalog = await runCatalog(ROOT, FULL);
  assert.throws(() => resolveSelection(catalog, { provider: 'alpha', model: 'alpha/deleted', thinking: 'default', effort: 'default' }),
    /已不存在/);
  assert.throws(() => resolveSelection(catalog, { provider: 'gone', model: 'gone/model', thinking: 'default', effort: 'default' }),
    /提供方已不存在/);
  assert.throws(() => resolveSelection(catalog, { provider: 'beta', model: 'alpha/opus', thinking: 'default', effort: 'default' }),
    /不属于提供方/);
});

test('an effort outside the declared list is rejected with the allowed values', async () => {
  const catalog = await runCatalog(ROOT, FULL);
  assert.throws(() => resolveSelection(catalog, { provider: 'beta', model: 'beta/k3', thinking: 'on', effort: 'medium' }),
    /不支持等级 medium/);
  assert.doesNotThrow(() => resolveSelection(catalog, { provider: 'beta', model: 'beta/k3', thinking: 'on', effort: 'max' }));
});

test('models without declared effort levels can only follow the default', async () => {
  const catalog = await runCatalog(ROOT, FULL);
  assert.throws(() => resolveSelection(catalog, { provider: 'alpha', model: 'alpha/always', thinking: 'on', effort: 'high' }),
    /没有声明思考等级/);
});

test('always-thinking models cannot have thinking turned off', async () => {
  const catalog = await runCatalog(ROOT, FULL);
  assert.throws(() => resolveSelection(catalog, { provider: 'alpha', model: 'alpha/always', thinking: 'off', effort: 'default' }),
    /始终开启思考/);
});

test('models without the thinking capability reject thinking settings', async () => {
  const catalog = await runCatalog(ROOT, FULL);
  assert.throws(() => resolveSelection(catalog, { provider: 'alpha', model: 'alpha/no-thinking', thinking: 'off', effort: 'default' }),
    /不支持思考设置/);
  assert.throws(() => resolveSelection(catalog, { provider: 'alpha', model: 'alpha/no-thinking', thinking: 'on', effort: 'default' }),
    /不支持思考设置/);
  assert.throws(() => resolveSelection(catalog, { provider: 'alpha', model: 'alpha/no-thinking', thinking: 'default', effort: 'high' }),
    /不支持思考等级/);
});

test('disabling thinking and picking an effort at the same time is rejected', async () => {
  const catalog = await runCatalog(ROOT, FULL);
  assert.throws(() => resolveSelection(catalog, { provider: 'alpha', model: 'alpha/opus', thinking: 'off', effort: 'high' }),
    /不能同时指定思考等级/);
});

test('empty provider and model mean follow the Kimi default', async () => {
  const catalog = await runCatalog(ROOT, FULL);
  const resolved = resolveSelection(catalog, { provider: '', model: '', thinking: 'default', effort: 'default' });
  assert.equal(resolved.provider, '');
  assert.equal(resolved.model, '');
  assert.equal(resolved.effectiveModel, 'alpha/opus');
  assert.deepEqual(planThinking(catalog, resolved), { value: null, requested: 'default' });
});

test('planThinking turns the request into a concrete CLI value', async () => {
  const catalog = await runCatalog(ROOT, FULL);
  const on = resolveSelection(catalog, { provider: 'alpha', model: 'alpha/opus', thinking: 'on', effort: 'low' });
  assert.deepEqual(planThinking(catalog, on), { value: 'low', requested: 'on' });
  const auto = resolveSelection(catalog, { provider: 'alpha', model: 'alpha/opus', thinking: 'on', effort: 'default' });
  assert.deepEqual(planThinking(catalog, auto), { value: 'high', requested: 'on' });
  const off = resolveSelection(catalog, { provider: 'alpha', model: 'alpha/opus', thinking: 'off', effort: 'default' });
  assert.deepEqual(planThinking(catalog, off), { value: 'off', requested: 'off' });
});

test('enabling a boolean-only model does not send an unsupported global effort', () => {
  const resolved = { thinking: 'on', effort: 'default', entry: { support_efforts: null, default_effort: null } };
  assert.deepEqual(planThinking({ thinking: { effort: 'high' } }, resolved), { value: 'on', requested: 'on' });
  resolved.entry.support_efforts = ['low', 'medium', 'max'];
  assert.deepEqual(planThinking({ thinking: { effort: 'high' } }, resolved), { value: 'medium', requested: 'on' });
});

test('terminal launch only forwards the effort env for kimi-protocol providers', async () => {
  const catalog = await runCatalog(ROOT, FULL);
  const beta = resolveSelection(catalog, { provider: 'beta', model: 'beta/k3', thinking: 'on', effort: 'max' });
  const kimiLaunch = buildTerminalLaunch({ catalog, resolved: beta, executable: 'kimi.exe', env: {} });
  assert.deepEqual(kimiLaunch.args, ['-m', 'beta/k3']);
  assert.equal(kimiLaunch.env.KIMI_MODEL_THINKING_EFFORT, 'max');
  assert.equal(kimiLaunch.thinkingHonored, true);
  assert.equal(kimiLaunch.notice, '');

  const alpha = resolveSelection(catalog, { provider: 'alpha', model: 'alpha/opus', thinking: 'on', effort: 'low' });
  const cliLaunch = buildTerminalLaunch({ catalog, resolved: alpha, executable: 'kimi.exe', env: {} });
  assert.deepEqual(cliLaunch.args, ['-m', 'alpha/opus']);
  assert.equal(cliLaunch.env.KIMI_MODEL_THINKING_EFFORT, undefined);
  assert.equal(cliLaunch.thinkingHonored, false);
  assert.match(cliLaunch.notice, /跟随 Kimi 全局配置/);
});

test('a default-model selection passes no -m flag', async () => {
  const catalog = await runCatalog(ROOT, FULL);
  const resolved = resolveSelection(catalog, { provider: '', model: '', thinking: 'default', effort: 'default' });
  const launch = buildTerminalLaunch({ catalog, resolved, executable: 'kimi.exe', env: {} });
  assert.deepEqual(launch.args, []);
  assert.equal(launch.env.KIMI_MODEL_THINKING_EFFORT, undefined);
});

test('selection preferences persist without touching the global Kimi config', async () => {
  const dataDir = tempDir();
  const before = hashFile(FULL);
  const saved = saveSelection(dataDir, { provider: 'beta', model: 'beta/k3', thinking: 'on', effort: 'max' });
  assert.deepEqual(saved, { provider: 'beta', model: 'beta/k3', thinking: 'on', effort: 'max' });
  assert.equal(selectionPath(dataDir), path.join(dataDir, 'kimi-selection.json'));
  assert.deepEqual(readSelection(dataDir), saved);
  assert.equal(hashFile(FULL), before, 'the global config must stay byte-identical');
  assert.equal(fs.existsSync(selectionPath(dataDir) + '.' + process.pid + '.tmp'), false);
});

test('saved selections are revalidated against the refreshed catalog', async () => {
  const dataDir = tempDir();
  saveSelection(dataDir, { provider: 'alpha', model: 'alpha/deleted', thinking: 'default', effort: 'default' });
  const catalog = await runCatalog(ROOT, FULL);
  assert.throws(() => resolveSelection(catalog, readSelection(dataDir)), /已不存在/);
});

test('a missing or corrupt preferences file falls back to the defaults', () => {
  const dataDir = tempDir();
  assert.deepEqual(readSelection(dataDir), DEFAULT_SELECTION);
  fs.writeFileSync(selectionPath(dataDir), '{ not json', 'utf8');
  assert.deepEqual(readSelection(dataDir), DEFAULT_SELECTION);
});

test('selection input is sanitized before it is stored', () => {
  assert.deepEqual(normalizeSelection({ provider: '  alpha  ', model: ' alpha/opus ', thinking: 'sideways', effort: '  ' }),
    { provider: 'alpha', model: 'alpha/opus', thinking: 'default', effort: 'default' });
  assert.deepEqual(normalizeSelection(null), DEFAULT_SELECTION);
});

test('a broken config reports a readable error without echoing file content', async () => {
  await assert.rejects(async () => runCatalog(ROOT, BROKEN), error => {
    assert.match(error.message, /解析失败/);
    assert.equal(error.message.includes('DUMMY-SECRET-DO-NOT-ECHO'), false);
    return true;
  });
});

test('a missing config reports a readable error', async () => {
  await assert.rejects(async () => runCatalog(ROOT, path.join(FIXTURES, 'does-not-exist.toml')),
    /没有找到 Kimi 配置文件/);
});

test('a byte-order mark does not break parsing', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, '\uFEFF' + fs.readFileSync(FULL, 'utf8'), 'utf8');
  const catalog = await runCatalog(ROOT, file);
  assert.equal(catalog.default_model, 'alpha/opus');
});
