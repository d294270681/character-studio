// App-owned provider profiles. Only the main process can decrypt credentials.
const fs = require('node:fs');
const path = require('node:path');
const { appDirectory } = require('./runtime-paths.cjs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { runCatalog, pythonExecutable, normalizeSelection, readSelection, saveSelection,
  resolveSelection, planThinking } = require('./kimi-config.cjs');
const { ModelMetadataCatalog, parseMetadata, enrichModel, inputBudget, FIELDS, EFFORTS, normalizeProtocol } = require('./model-metadata.cjs');

const BUILTIN = 'opencode-go';
const DEFAULT_MODEL = BUILTIN + '/deepseek-v4.1-flash';
const DEFAULT_SELECTION = { provider: BUILTIN, model: DEFAULT_MODEL, thinking: 'on', effort: 'low' };
const PROTOCOLS = ['openai', 'anthropic', 'openai_responses'];

function endpoint(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('请填写完整的 Endpoint，例如 https://example.com/v1。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Endpoint 只能使用 HTTP/HTTPS，不能包含用户名、密码或查询参数。');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('远程服务请使用 HTTPS；本地服务可以使用 HTTP。');
  url.pathname = url.pathname.replace(/\/(chat\/completions|messages|responses|models)\/?$/, '').replace(/\/+$/, '');
  return url.toString().replace(/\/+$/, '');
}

function protocol(value) {
  const result = value === 'openai_legacy' ? 'openai' : value;
  if (!PROTOCOLS.includes(result)) throw new Error('目前支持 OpenAI Chat Completions、Responses 和 Anthropic Messages 协议。');
  return result;
}
function textId(value, label = '模型 ID') {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id || id.length > 220 || /[\x00-\x1f\x7f]/.test(id)) throw new Error(label + '不能为空或包含控制字符。');
  return id;
}
function number(value) { return Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null; }
function bool(value) { return typeof value === 'boolean' ? value : null; }
function effortList(value) { return Array.isArray(value) ? [...new Set(value.filter(item => EFFORTS.includes(item)))] : null; }
function sanitizeError(error, key = '') {
  let message = String(error?.message || error || '请求失败');
  if (key) message = message.split(key).join('[已隐藏密钥]');
  return message.replace(/(?:Bearer\s+|sk-)[a-zA-Z0-9_.-]+/gi, '[已隐藏密钥]').slice(0, 400);
}

function modelMetadata(raw, providerId) {
  const model = textId(raw.id || raw.model);
  const result = {
    id: providerId + '/' + model, provider: providerId, model,
    label: String(raw.display_name || raw.name || model).slice(0, 200), enabled: false,
    ...parseMetadata(raw),
    metadata_source: 'endpoint', metadata_sources: {}, overrides: {},
  };
  for (const field of FIELDS) result.metadata_sources[field] = result[field] == null ? 'unknown' : 'endpoint';
  return result;
}

function effectiveModel(model) {
  const result = { ...model, ...(model.overrides || {}), metadata_sources: { ...(model.metadata_sources || {}) } };
  for (const field of Object.keys(model.overrides || {})) result.metadata_sources[field] = 'manual';
  if (result.default_effort && result.support_efforts?.length && !result.support_efforts.includes(result.default_effort)) result.default_effort = null;
  const caps = ['tool_use', 'image_in', 'video_in', 'audio_in'].filter(field => result[field] === true);
  if (result.thinking_supported === true) caps.push('thinking');
  if (result.always_thinking === true) caps.push('always_thinking');
  result.capabilities = caps.length ? caps : null;
  if (result.can_disable_thinking == null) {
    if (result.thinking_supported === false || result.always_thinking === true) result.can_disable_thinking = false;
    else if (result.thinking_supported === true && result.always_thinking === false) result.can_disable_thinking = true;
  }
  delete result.overrides;
  result.studio_overrides = Object.keys(model.overrides || {});
  Object.assign(result, inputBudget(result));
  return result;
}

function readBuiltinConnection(root) {
  const python = pythonExecutable(root);
  if (!python) throw new Error('没有找到 Python，无法读取现有 Kimi 服务。');
  const result = spawnSync(python, ['-B', '-s', path.join(appDirectory(root), 'kimi_provider.py'), '--provider', BUILTIN],
    { encoding: 'utf8', windowsHide: true, timeout: 15000, env: { ...process.env, PYTHONUTF8: '1' }, maxBuffer: 1024 * 1024 });
  let data;
  try { data = JSON.parse(result.stdout); } catch { throw new Error('无法读取现有 Kimi 服务。'); }
  if (data.error) throw new Error(data.error);
  return data;
}

class ProviderManager {
  constructor(bridge, { secureStorage, fetch: fetchImpl = globalThis.fetch, catalogReader = runCatalog,
    connectionReader = readBuiltinConnection, busy = () => false, metadataCatalog = null } = {}) {
    this.bridge = bridge;
    this.secureStorage = secureStorage;
    this.fetch = fetchImpl;
    this.catalogReader = catalogReader;
    this.connectionReader = connectionReader;
    this.busy = busy;
    this.metadata = metadataCatalog || new ModelMetadataCatalog(bridge.data);
    this.file = path.join(bridge.data, 'kimi-providers.json');
    this.profiles = [];
    this.networkBusy = new Set();
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(data.providers)) throw new Error('shape');
      this.profiles = data.providers;
    } catch (error) {
      if (error.code !== 'ENOENT') this.loadError = '模型配置文件无法读取，请修复 kimi-providers.json 后再保存。';
    }
  }
  persist() {
    if (this.loadError) throw new Error(this.loadError);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, providers: this.profiles }, null, 2) + '\n', 'utf8');
    fs.renameSync(temporary, this.file);
  }
  builtin() {
    try {
      const raw = this.catalogReader(this.bridge.root);
      const model = raw.models.find(item => item.id === DEFAULT_MODEL && item.provider === BUILTIN);
      if (!model) return null;
      const connection = this.connectionReader(this.bridge.root);
      const sources = Object.fromEntries(FIELDS.map(field => [field, model.manual_fields?.includes(field) ? 'kimi_override'
        : model[field] == null ? 'unknown' : 'kimi_config']));
      const stored = this.profiles.find(item => item.id === BUILTIN);
      const primary = stored?.models.find(item => item.id === DEFAULT_MODEL);
      const mainModel = { ...model, enabled: primary?.enabled ?? true, metadata_source: 'kimi_config', metadata_sources: sources,
        overrides: primary?.overrides || {}, metadata_details: primary?.metadata_details || {} };
      for (const field of FIELDS) if (primary?.[field] != null && sources[field] !== 'kimi_override'
        && (mainModel[field] == null || ['endpoint', 'models_dev', 'model_reference'].includes(primary.metadata_sources?.[field]))) {
        mainModel[field] = primary[field]; mainModel.metadata_sources[field] = primary.metadata_sources?.[field] || 'endpoint';
      }
      if (primary?.metadata_source === 'combined') mainModel.metadata_source = 'combined';
      const models = [mainModel, ...(stored?.models || []).filter(item => item.id !== DEFAULT_MODEL)];
      return { id: BUILTIN, label: 'OpenCode Go', endpoint: endpoint(connection.endpoint),
        protocol: protocol(connection.type), has_key: !!connection.api_key, readonly: true, models,
        thinking: raw.thinking };
    } catch { return null; }
  }
  provider(id) {
    const result = id === BUILTIN ? this.builtin() : this.profiles.find(item => item.id === id);
    if (!result) throw new Error('找不到这个服务，请重新打开模型管理。');
    return result;
  }
  stored(provider) {
    let record = this.profiles.find(item => item.id === provider.id);
    if (!record) { record = { id: provider.id, models: [] }; this.profiles.push(record); }
    return record;
  }
  connection(provider) {
    if (provider.id === BUILTIN) return this.connectionReader(this.bridge.root);
    let apiKey = '';
    if (provider.encrypted_key) {
      if (!this.secureStorage?.isEncryptionAvailable()) throw new Error('Windows 密钥保护暂时不可用。');
      try { apiKey = this.secureStorage.decryptString(Buffer.from(provider.encrypted_key, 'base64')); }
      catch { throw new Error('无法解密此 API Key，请重新填写并保存。'); }
    }
    return { endpoint: provider.endpoint, type: provider.protocol, api_key: apiKey, custom_headers: {} };
  }
  allProviders() {
    const builtin = this.builtin();
    return [...(builtin ? [builtin] : []), ...this.profiles.filter(item => item.id !== BUILTIN)];
  }
  async autoMetadata({ providerId, force = false } = {}) {
    if (this.busy() || this.loadError) return;
    await this.metadata.refresh({ force });
    if (this.busy()) return;
    const before = JSON.stringify(this.profiles);
    for (const provider of this.allProviders()) {
      if (providerId && provider.id !== providerId) continue;
      const models = provider.models.map(model => enrichModel(model, this.metadata.match(provider, model)));
      if (JSON.stringify(models) !== JSON.stringify(provider.models)) this.stored(provider).models = models;
    }
    if (before !== JSON.stringify(this.profiles)) this.persist();
  }
  catalog() {
    const all = this.allProviders();
    const models = all.flatMap(provider => provider.models.filter(model => model.enabled).map(effectiveModel));
    const providers = all.filter(provider => models.some(model => model.provider === provider.id))
      .map(provider => ({ id: provider.id, label: provider.label, type: provider.protocol,
        model_count: models.filter(model => model.provider === provider.id).length }));
    return { schema_version: 2, default_model: models.find(model => model.id === DEFAULT_MODEL)?.id || models[0]?.id || '',
      fixed_model: models.length === 1 && models[0].id === DEFAULT_MODEL,
      providers, models, thinking: this.builtin()?.thinking || { enabled: true, effort: null } };
  }
  selection(catalog = this.catalog()) {
    const saved = readSelection(this.bridge.data);
    try {
      if (saved.model) { resolveSelection(catalog, saved); return saved; }
    } catch { /* profile was removed or edited */ }
    if (catalog.models.some(model => model.id === DEFAULT_MODEL)) {
      try { resolveSelection(catalog, DEFAULT_SELECTION); return { ...DEFAULT_SELECTION }; }
      catch { return { provider: BUILTIN, model: DEFAULT_MODEL, thinking: 'default', effort: 'default' }; }
    }
    const first = catalog.models[0];
    return first ? { provider: first.provider, model: first.id, thinking: 'default', effort: 'default' }
      : { provider: '', model: '', thinking: 'default', effort: 'default' };
  }
  state(extra = {}) {
    const providers = this.allProviders().map(provider => ({ id: provider.id, label: provider.label,
      endpoint: provider.endpoint, protocol: provider.protocol,
      has_key: provider.readonly ? provider.has_key : !!provider.encrypted_key, readonly: !!provider.readonly,
      discovered_at: provider.discovered_at || null, models: provider.models.map(effectiveModel) }));
    return { providers, selection: this.selection(), busy: !!this.busy(), catalog_status: this.metadata.status || null, ...extra,
      ...(this.loadError ? { notice: this.loadError } : {}) };
  }
  headers(connection, isAnthropic = false) {
    const headers = { ...connection.custom_headers, 'User-Agent': 'CharacterStudio/2.8 Kimi-Agent',
      'x-opencode-session': 'character-studio-' + crypto.createHash('sha256').update(this.bridge.data).digest('hex').slice(0, 24) };
    if (connection.api_key) headers[isAnthropic ? 'x-api-key' : 'Authorization'] = isAnthropic ? connection.api_key : 'Bearer ' + connection.api_key;
    if (isAnthropic) headers['anthropic-version'] = '2023-06-01';
    return headers;
  }
  async request(connection, route, options = {}) {
    let response;
    try {
      response = await this.fetch(endpoint(connection.endpoint) + route, { ...options, redirect: 'error',
        signal: AbortSignal.timeout(20000), headers: { ...this.headers(connection, connection.type === 'anthropic'), ...options.headers } });
    } catch (error) {
      throw new Error(error.name === 'TimeoutError' || error.name === 'AbortError' ? '服务响应超过 20 秒，请检查 Endpoint 和网络。'
        : '连接服务失败，请检查 Endpoint、网络或 TLS 证书。');
    }
    if (!response.ok) {
      const reasons = { 401: 'API Key 无效或未填写', 403: '此账号无权访问模型，或服务拒绝了请求',
        404: '接口不存在，可手动添加模型并检查协议', 429: '达到限流或额度限制' };
      // Never echo an upstream body: gateways may reflect credentials in it.
      await response.body?.cancel().catch(() => {});
      throw new Error('HTTP ' + response.status + ' · ' + (reasons[response.status] || '服务暂时无法处理请求'));
    }
    const length = Number(response.headers.get('content-length'));
    if (length > 8 * 1024 * 1024) { await response.body?.cancel(); throw new Error('模型列表响应过大。'); }
    const reader = response.body.getReader();
    let size = 0; const chunks = [];
    while (true) { const item = await reader.read(); if (item.done) break; size += item.value.length;
      if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('模型列表响应过大。'); } chunks.push(Buffer.from(item.value)); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('服务返回的不是有效 JSON，请检查 Endpoint。'); }
  }
  async action(action, payload = {}) {
    if (action === 'list') { await this.autoMetadata(); return this.state(); }
    if (this.busy()) throw new Error('助手正在执行任务，请完成或停止后再调整模型配置。');
    if (this.loadError) throw new Error(this.loadError);
    const id = payload.provider_id || payload.id;
    if (this.networkBusy.has(id)) throw new Error('正在查询这个服务，请稍候。');
    if (action === 'save') {
      const current = payload.id ? this.provider(payload.id) : null;
      if (current?.readonly) throw new Error('现有 Kimi 服务连接由全局配置管理，可新建一个独立服务。');
      const address = endpoint(payload.endpoint);
      const kind = protocol(payload.protocol || 'openai');
      const label = textId(payload.label || new URL(address).hostname, '服务名称');
      const key = typeof payload.api_key === 'string' ? payload.api_key.trim() : '';
      if (key.length > 8192 || /[\r\n\x00]/.test(key)) throw new Error('API Key 格式无效。');
      let encrypted = current?.encrypted_key || '';
      if (key) {
        if (!this.secureStorage?.isEncryptionAvailable()) throw new Error('Windows 密钥保护不可用，暂时无法保存 API Key。');
        encrypted = this.secureStorage.encryptString(key).toString('base64');
      }
      const providerId = current?.id || 'studio-' + crypto.randomUUID().slice(0, 8);
      const models = current?.endpoint && current.endpoint !== address
        ? current.models.map(model => ({ ...modelMetadata({ id: model.model, display_name: model.label }, providerId), overrides: model.overrides || {} }))
        : current?.models || [];
      const record = { id: providerId, label, endpoint: address, protocol: kind, encrypted_key: encrypted,
        models, discovered_at: current?.endpoint === address ? current?.discovered_at || null : null };
      const index = this.profiles.findIndex(item => item.id === providerId);
      if (index < 0) this.profiles.push(record); else this.profiles[index] = record;
      this.persist();
      return this.state({ saved_provider_id: providerId, notice: '连接已保存，可以拉取模型列表。' });
    }
    const provider = this.provider(id);
    if (action === 'sync_metadata') {
      await this.autoMetadata({ providerId: id, force: true });
      try { return await this.action('discover', { provider_id: id }); }
      catch (error) { return this.state({ notice: '模型目录已匹配；服务列表未更新：' + sanitizeError(error) }); }
    }
    if (action === 'discover' || action === 'probe') {
      this.networkBusy.add(id);
      try {
        const connection = this.connection(provider);
        if (action === 'discover') {
          const result = await this.request(connection, '/models');
          const rows = Array.isArray(result) ? result : result.data || result.models;
          if (!Array.isArray(rows) || !rows.length) throw new Error('服务没有返回模型列表，可以手动添加模型。');
          const merged = new Map(provider.models.map(model => [model.id, model]));
          for (const row of rows.slice(0, 2000)) {
            if (!row || typeof row !== 'object' || !(row.id || row.model)) continue;
            const discovered = modelMetadata(row, id);
            const previous = merged.get(discovered.id);
            // Retain trusted local metadata when a minimal /models entry omits it.
            if (previous) for (const field of FIELDS) if (discovered[field] == null && previous[field] != null) {
              discovered[field] = previous[field]; discovered.metadata_sources[field] = previous.metadata_sources?.[field] || previous.metadata_source;
            }
            merged.set(discovered.id, { ...discovered, enabled: previous?.enabled ?? false, overrides: previous?.overrides || {},
              metadata_details: { ...(previous?.metadata_details || {}) } });
          }
          const stored = this.stored(provider);
          stored.models = [...merged.values()]; stored.discovered_at = new Date().toISOString(); this.persist();
          await this.autoMetadata({ providerId: id });
          return this.state({ notice: '已读取 ' + rows.length + ' 个模型，并自动匹配思考等级、输入输出限制和能力。'
            + (this.metadata.status?.notice || '') });
        }
        const model = effectiveModel(provider.models.find(item => item.id === payload.model_id) || {});
        if (!model.model) throw new Error('请先选择要测试的模型。');
        const started = Date.now();
        const tool = { name: 'studio_connection_check', description: 'Check connection only; return status ok.',
          parameters: { type: 'object', properties: { status: { type: 'string', enum: ['ok'] } }, required: ['status'] } };
        const kind = model.protocol || provider.protocol;
        const body = kind === 'anthropic'
          ? { model: model.model, max_tokens: 64, messages: [{ role: 'user', content: 'Call studio_connection_check with status ok.' }],
            tools: [{ name: tool.name, description: tool.description, input_schema: tool.parameters }], tool_choice: { type: 'tool', name: tool.name } }
          : kind === 'openai_responses' ? { model: model.model, max_output_tokens: 64, input: 'Call studio_connection_check with status ok.',
            tools: [{ type: 'function', ...tool }], tool_choice: 'auto' }
          : { model: model.model, max_tokens: 64, stream: false, messages: [{ role: 'user', content: 'Call studio_connection_check with status ok.' }],
            tools: [{ type: 'function', function: tool }], tool_choice: 'auto' };
        const result = await this.request({ ...connection, type: kind }, kind === 'anthropic' ? '/messages' : kind === 'openai_responses' ? '/responses' : '/chat/completions',
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const called = kind === 'anthropic'
          ? result.content?.some(item => item.type === 'tool_use' && item.name === tool.name)
          : kind === 'openai_responses' ? result.output?.some(item => item.type === 'function_call' && item.name === tool.name)
          : result.choices?.some(item => item.message?.tool_calls?.some(call => call.function?.name === tool.name));
        const valid = kind === 'anthropic' ? Array.isArray(result.content) : kind === 'openai_responses' ? Array.isArray(result.output)
          : Array.isArray(result.choices) && result.choices.length;
        if (!valid) throw new Error('服务响应成功，但返回格式与所选协议不匹配。');
        return this.state({ test: { passed: true, latency_ms: Date.now() - started, tool_call_verified: !!called,
          message: called ? '模型请求成功，工具调用已验证。' : '模型请求成功；本次未返回工具调用，工具能力尚未确认。' } });
      } catch (error) { throw new Error(sanitizeError(error)); }
      finally { this.networkBusy.delete(id); }
    }
    const stored = this.stored(provider);
    if (action === 'remove') {
      if (provider.readonly) throw new Error('现有 Kimi 服务不能从角色工坊删除。');
      this.profiles = this.profiles.filter(item => item.id !== id); this.persist();
      saveSelection(this.bridge.data, this.selection());
      return this.state({ notice: '服务已移除。' });
    }
    if (action === 'add_model') {
      const model = modelMetadata({ id: textId(payload.model), display_name: payload.label }, id);
      if (provider.models.some(item => item.id === model.id)) throw new Error('这个模型已经在列表里。');
      model.metadata_source = 'manual';
      stored.models.push(model); this.persist();
      if (payload.values) await this.action('update_model', { provider_id: id, model_id: model.id, values: payload.values });
      await this.autoMetadata({ providerId: id });
      return this.state({ notice: '已添加模型并匹配可用规格。' });
    }
    const baseModel = provider.models.find(item => item.id === payload.model_id);
    if (!baseModel) throw new Error('找不到这个模型。');
    let model = stored.models.find(item => item.id === payload.model_id);
    if (!model) { model = { ...baseModel, overrides: { ...(baseModel.overrides || {}) } }; stored.models.push(model); }
    if (action === 'reset_metadata') {
      model.overrides = {}; this.persist();
      await this.autoMetadata({ providerId: id });
      return this.state({ notice: '已恢复自动规格；Kimi 全局手动配置继续保留。' });
    }
    if (action === 'update_model') {
      const values = payload.values || {};
      const overrides = { ...(model.overrides || {}) };
      for (const field of FIELDS) if (Object.hasOwn(values, field)) {
        const value = values[field];
        if (JSON.stringify(value ?? null) === JSON.stringify(effectiveModel(model)[field] ?? null)) continue;
        if (['max_context_size', 'max_input_tokens', 'max_output_tokens'].includes(field)) {
          if (value == null || value === '') overrides[field] = null;
          else { const size = number(value); if (!size || size > 100000000) throw new Error('Token 上限必须是合理的正整数。'); overrides[field] = size; }
        } else if (field === 'protocol') {
          overrides[field] = value == null ? null : protocol(value);
        } else if (field === 'declared_efforts') {
          continue;
        } else if (field === 'support_efforts') {
          if (value != null && (!Array.isArray(value) || value.some(item => !EFFORTS.includes(item)))) throw new Error('包含当前 Kimi 不支持的思考等级。');
          overrides[field] = effortList(value);
        } else if (field.endsWith('effort')) {
          if (value != null && !EFFORTS.includes(value)) throw new Error('无效的思考等级。'); overrides[field] = value;
        } else { if (value != null && typeof value !== 'boolean') throw new Error('能力设置只能为支持、不支持或未知。'); overrides[field] = value; }
      }
      model.overrides = overrides;
      if (typeof values.enabled === 'boolean') model.enabled = values.enabled;
      this.persist();
      return this.state({ notice: '模型配置已保存。' });
    }
    if (action === 'select') {
      if (effectiveModel(baseModel).tool_use === false) throw new Error('该模型不支持工具调用，无法执行角色生成。');
      const saved = readSelection(this.bridge.data);
      const explicit = payload.thinking !== undefined || payload.effort !== undefined;
      let selection = explicit ? normalizeSelection({ provider: id, model: model.id, thinking: payload.thinking, effort: payload.effort })
        : saved.model === model.id ? saved : { provider: id, model: model.id, thinking: 'default', effort: 'default' };
      const catalog = this.catalog();
      if (!catalog.providers.some(item => item.id === id)) catalog.providers.push({ id, type: provider.protocol });
      if (!catalog.models.some(item => item.id === model.id)) catalog.models.push(effectiveModel(model));
      try { resolveSelection(catalog, selection); }
      catch (error) {
        if (explicit) throw error;
        selection = { provider: id, model: model.id, thinking: 'default', effort: 'default' };
      }
      model.enabled = true; this.persist();
      saveSelection(this.bridge.data, selection);
      return this.state({ notice: '已应用到 Kimi 助手。' });
    }
    throw new Error('未知的模型管理操作。');
  }
  prepareRuntime(selection, thinking, directory) {
    const provider = this.provider(selection.provider);
    const model = effectiveModel(provider.models.find(item => item.id === selection.model) || {});
    if (!model.model) throw new Error('所选模型已不存在。');
    const connection = this.connection(provider);
    const node = [process.env.CHARACTER_STUDIO_NODE, path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
      ...String(process.env.PATH || '').split(path.delimiter).map(folder => path.join(folder, 'node.exe'))]
      .find(file => file && fs.existsSync(file));
    if (!node) throw new Error('没有找到角色工坊 MCP 所需的 Node.js 运行环境。');
    const home = path.join(directory, 'kimi-home'); fs.mkdirSync(home, { recursive: true });
    const budget = inputBudget(model);
    const kind = model.protocol || provider.protocol;
    const runtimeModel = { provider: provider.id, model: model.model, display_name: model.label,
      max_context_size: budget.context, max_input_size: budget.runtime_input_limit };
    if (model.capabilities) runtimeModel.capabilities = model.capabilities;
    if (model.support_efforts?.length) runtimeModel.support_efforts = model.support_efforts;
    if (model.default_effort) runtimeModel.default_effort = model.default_effort;
    if (model.off_effort) runtimeModel.off_effort = model.off_effort;
    if (model.max_output_tokens && kind === 'anthropic') runtimeModel.max_output_size = Math.min(model.max_output_tokens, budget.context);
    const baseThinking = this.catalog().thinking;
    const isOn = thinking.value === 'off' ? false : thinking.value ? true : baseThinking.enabled;
    const effort = thinking.value && !['on', 'off'].includes(thinking.value) ? thinking.value
      : model.support_efforts?.includes(baseThinking.effort) ? baseThinking.effort : model.default_effort;
    const config = { default_model: model.id, auto_session_title: false, telemetry: false,
      providers: { [provider.id]: { type: kind, base_url: endpoint(connection.endpoint),
        ...(connection.api_key ? { api_key_env: 'CHARACTER_STUDIO_PROVIDER_KEY' } : { api_key: '' }),
        custom_headers: this.headers({ ...connection, api_key: '' }) } },
      models: { [model.id]: runtimeModel }, thinking: { enabled: isOn, ...(effort ? { effort } : {}) },
      loop_control: { reserved_context_size: budget.reserved_output_tokens, max_attempts_per_step: 3 } };
    // A tiny serializer keeps secrets out of configuration. Keys only travel in
    // the child environment; global Kimi configuration is never edited.
    function tomlValue(value) { return JSON.stringify(value); }
    const lines = [];
    function write(object, keys = []) {
      const entries = Object.entries(object).filter(([, v]) => v !== undefined && v !== null);
      if (keys.length) lines.push('[' + keys.map(tomlValue).join('.') + ']');
      for (const [key, value] of entries) if (typeof value !== 'object' || Array.isArray(value)) lines.push(tomlValue(key) + ' = ' + tomlValue(value));
      for (const [key, value] of entries) if (value && typeof value === 'object' && !Array.isArray(value)) { lines.push(''); write(value, [...keys, key]); }
    }
    write(config); fs.writeFileSync(path.join(home, 'config.toml'), lines.join('\n') + '\n', 'utf8');
    fs.writeFileSync(path.join(home, 'mcp.json'), JSON.stringify({ mcpServers: { character_studio: {
      command: node, args: [path.join(appDirectory(this.bridge.root), 'electron', 'mcp.cjs')], env: {
        CHARACTER_STUDIO_ROOT: this.bridge.root, CHARACTER_STUDIO_DATA: this.bridge.data, CHARACTER_STUDIO_PORT: String(this.bridge.port) },
    } } }, null, 2));
    return { env: { KIMI_CODE_HOME: home, CHARACTER_STUDIO_PROVIDER_KEY: connection.api_key || '' }, home,
      cleanup() { for (const filename of ['config.toml', 'mcp.json']) {
        try { fs.rmSync(path.join(home, filename), { force: true }); } catch { /* the terminal wrapper retries after exit */ }
      } } };
  }
}

module.exports = { ProviderManager, modelMetadata, effectiveModel, endpoint, protocol, sanitizeError, DEFAULT_MODEL, DEFAULT_SELECTION };
