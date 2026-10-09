// Normalize model metadata without inventing limits or reasoning variants.
const fs = require('node:fs');
const path = require('node:path');
const CATALOG_URL = 'https://models.dev/api.json';
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 32 * 1024 * 1024;
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const FIELDS = ['tool_use', 'image_in', 'video_in', 'audio_in', 'pdf_in', 'structured_output', 'temperature',
  'thinking_supported', 'always_thinking', 'can_disable_thinking', 'support_efforts', 'declared_efforts',
  'max_context_size', 'max_input_tokens', 'max_output_tokens', 'default_effort', 'off_effort', 'protocol'];
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const boolean = value => typeof value === 'boolean' ? value : null;
const list = value => Array.isArray(value) ? [...new Set(value.filter(item => typeof item === 'string'))] : null;

function normalizeProtocol(value) {
  if (['openai', 'openai_legacy', 'chat-completions', 'openai-compatible', '@ai-sdk/openai-compatible'].includes(value)) return 'openai';
  if (['anthropic', 'messages', '@ai-sdk/anthropic'].includes(value)) return 'anthropic';
  if (['openai_responses', 'responses', '@ai-sdk/openai'].includes(value)) return 'openai_responses';
  return null;
}

function parseMetadata(raw) {
  const caps = raw.capabilities;
  const tags = Array.isArray(caps) ? caps : null;
  const flag = (...names) => {
    for (const name of names) { const value = boolean(raw[name]) ?? boolean(caps?.[name]); if (value !== null) return value; }
    return null;
  };
  const modalities = list(raw.modalities?.input || raw.input_modalities || raw.architecture?.input_modalities);
  const media = (field, ...names) => flag(field, ...names) ?? (modalities ? modalities.includes(names[0]) : tags ? tags.includes(field) : null);
  const options = Array.isArray(raw.reasoning_options) ? raw.reasoning_options : null;
  const declared = list(raw.support_efforts || raw.supported_reasoning_efforts || raw.reasoning_efforts || raw.parameters?.reasoning_effort?.enum
    || options?.find(option => option.type === 'effort')?.values || (options ? [] : null));
  const efforts = declared ? declared.filter(value => EFFORTS.includes(value)) : null;
  const toggle = options?.some(option => option.type === 'toggle') || declared?.includes('none');
  const result = {
    tool_use: flag('tool_use', 'tool_call', 'function_calling') ?? (tags ? tags.includes('tool_use') : null),
    image_in: media('image_in', 'image', 'vision'), video_in: media('video_in', 'video'), audio_in: media('audio_in', 'audio'), pdf_in: media('pdf_in', 'pdf'),
    structured_output: flag('structured_output'), temperature: flag('temperature'),
    thinking_supported: flag('thinking_supported', 'reasoning') ?? (declared?.length ? true : tags ? tags.includes('thinking') : null),
    always_thinking: flag('always_thinking') ?? (tags ? tags.includes('always_thinking') : null),
    can_disable_thinking: flag('can_disable_thinking') ?? (toggle ? true : null),
    support_efforts: efforts, declared_efforts: declared,
    max_context_size: positive(raw.max_context_size ?? raw.context_length ?? raw.context_window ?? raw.limit?.context ?? raw.limits?.context),
    max_input_tokens: positive(raw.max_input_tokens ?? raw.max_input_size ?? raw.input_token_limit ?? raw.limit?.input ?? raw.limits?.input),
    max_output_tokens: positive(raw.max_output_tokens ?? raw.max_output_size ?? raw.max_completion_tokens ?? raw.limit?.output ?? raw.limits?.output
      ?? raw.top_provider?.max_completion_tokens),
    default_effort: EFFORTS.includes(raw.default_effort) ? raw.default_effort : null,
    off_effort: EFFORTS.includes(raw.off_effort) ? raw.off_effort : declared?.includes('none') ? 'none' : null,
    protocol: normalizeProtocol(raw.protocol || raw.provider?.npm || raw.api?.type),
  };
  if (result.can_disable_thinking === true && result.always_thinking === null) result.always_thinking = false;
  return result;
}

function inputBudget(model) {
  const context = positive(model.max_context_size) || 32768;
  const inputLimit = Math.min(positive(model.max_input_tokens) || context, context);
  const reserved = Math.max(1, Math.min(8192, positive(model.max_output_tokens) || 8192, Math.floor(inputLimit / 4)));
  return { context, runtime_input_limit: inputLimit, reserved_output_tokens: reserved,
    input_budget: Math.max(1, inputLimit - reserved) };
}

async function jsonResponse(response, maxBytes = MAX_BYTES) {
  if (!response.ok) throw new Error('模型目录暂时不可用。');
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new Error('模型目录响应过大。'); }
  const reader = response.body.getReader(); let size = 0; const parts = [];
  while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length;
    if (size > maxBytes) { await reader.cancel(); throw new Error('模型目录响应过大。'); } parts.push(Buffer.from(part.value)); }
  const result = JSON.parse(Buffer.concat(parts).toString('utf8'));
  if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error('模型目录格式无效。');
  return result;
}

function urlKey(address) {
  try { const url = new URL(address); return url.origin.toLowerCase() + url.pathname.replace(/\/+$/, ''); }
  catch { return ''; }
}
function sameEndpoint(address, known) {
  const a = urlKey(address), b = urlKey(known);
  if (!a || !b) return false;
  if (a === b) return true;
  // Registries sometimes omit the /v1 suffix on a provider's root API.
  try { return new URL(b).pathname === '/' && a === b + '/v1'; } catch { return false; }
}

class ModelMetadataCatalog {
  constructor(data, { fetch = globalThis.fetch, now = Date.now } = {}) {
    this.fetch = fetch; this.now = now;
    this.file = path.join(data, 'model-catalog-cache.json');
    this.data = {}; this.updatedAt = 0; this.retryAfter = 0;
    try {
      if (fs.statSync(this.file).size <= MAX_BYTES + 1024) {
        const cached = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (cached.data && typeof cached.data === 'object') { this.data = cached.data; this.updatedAt = cached.updated_at || 0; }
      }
    } catch { /* offline cache is optional */ }
    this.status = { available: !!this.updatedAt, cached: !!this.updatedAt, updated_at: this.updatedAt ? new Date(this.updatedAt).toISOString() : null };
  }
  async refresh({ force = false } = {}) {
    if (!force && (this.now() - this.updatedAt < TTL_MS || this.now() < this.retryAfter)) return this.status;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        // No provider key, custom headers, or model query is sent to Models.dev.
        const response = await this.fetch(CATALOG_URL, { headers: { Accept: 'application/json', 'User-Agent': 'CharacterStudio/2.8' },
          redirect: 'error', signal: AbortSignal.timeout(8000) });
        const data = await jsonResponse(response);
        if (!Object.values(data).some(provider => provider && typeof provider.models === 'object')) throw new Error('shape');
        this.data = data; this.updatedAt = this.now(); this.retryAfter = 0;
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const temporary = this.file + '.' + process.pid + '.tmp';
        fs.writeFileSync(temporary, JSON.stringify({ updated_at: this.updatedAt, data })); fs.renameSync(temporary, this.file);
        this.status = { available: true, cached: false, updated_at: new Date(this.updatedAt).toISOString() };
      } catch {
        this.retryAfter = this.now() + 60000;
        this.status = { available: !!this.updatedAt, cached: !!this.updatedAt, updated_at: this.updatedAt ? new Date(this.updatedAt).toISOString() : null,
          notice: this.updatedAt ? '模型目录暂时无法更新，继续使用缓存规格。' : '模型目录暂时无法连接，保留接口与本地配置提供的信息。' };
      }
      return this.status;
    })();
    try { return await this.pending; } finally { this.pending = null; }
  }
  match(provider, model) {
    const services = Object.values(this.data).filter(item => item && sameEndpoint(provider.endpoint, item.api));
    const chosen = services.find(item => item.id === provider.id) || (services.length === 1 ? services[0] : null);
    const native = model.model || model.id;
    const direct = chosen?.models?.[native];
    if (direct) return { metadata: { ...parseMetadata(direct), protocol: parseMetadata(direct).protocol || normalizeProtocol(chosen.npm) }, label: direct.name, kind: 'models_dev',
      source: { kind: 'models_dev', provider_id: chosen.id, model_id: direct.id || native, url: CATALOG_URL,
        updated_at: this.updatedAt ? new Date(this.updatedAt).toISOString() : null, model_updated_at: direct.last_updated || null } };
    if (chosen) return null; // A provider-specific absence cannot be filled from a different gateway.
    // For a custom gateway use an exact canonical ID only. Never select a model
    // by substring, strip a version suffix, or copy another gateway's limits.
    const pairs = [];
    for (const service of Object.values(this.data)) for (const record of Object.values(service?.models || {})) {
      if ((record.id === native || record.canonical_model_id === native) && record.canonical_model_id) pairs.push(record.canonical_model_id);
    }
    const ids = [...new Set(pairs)];
    const canonical = ids.length === 1 ? ids[0] : null;
    if (!canonical) return null;
    const split = canonical.indexOf('/');
    const manufacturer = this.data[canonical.slice(0, split)];
    const record = manufacturer?.models?.[canonical.slice(split + 1)] || manufacturer?.models?.[canonical];
    if (!record) return null;
    const metadata = parseMetadata(record);
    metadata.protocol = null; // A proxy may choose a different wire protocol.
    return { metadata, label: record.name, kind: 'model_reference', source: { kind: 'model_reference', provider_id: manufacturer.id,
      model_id: record.id, url: CATALOG_URL, updated_at: this.updatedAt ? new Date(this.updatedAt).toISOString() : null,
      model_updated_at: record.last_updated || null } };
  }
}

function enrichModel(model, match) {
  if (!match) return { ...model };
  const result = { ...model, metadata_sources: { ...(model.metadata_sources || {}) }, metadata_details: { ...(model.metadata_details || {}) } };
  for (const field of FIELDS) {
    const value = match.metadata[field]; if (value == null) continue;
    const source = result.metadata_sources[field];
    if (source === 'endpoint' || source === 'kimi_override') continue;
    // Public manufacturer specs are a fallback, while a matched provider's
    // catalog replaces ordinary stale Kimi metadata. Manual overrides live in
    // model.overrides and are never changed here.
    if (match.kind === 'model_reference' && result[field] != null && !['model_reference', 'unknown'].includes(source)) continue;
    result[field] = value; result.metadata_sources[field] = match.kind; result.metadata_details[field] = match.source;
  }
  if (result.label === result.model && match.label) result.label = match.label;
  result.metadata_source = 'combined';
  return result;
}

module.exports = { ModelMetadataCatalog, parseMetadata, enrichModel, inputBudget, sameEndpoint, normalizeProtocol, FIELDS, EFFORTS, CATALOG_URL };
