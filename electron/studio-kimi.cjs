const { KimiRunner } = require('./kimi.cjs');
const { runCatalog, readSelection, saveSelection, normalizeSelection, resolveSelection, planThinking, findProvider } = require('./kimi-config.cjs');
const { executionStages } = require('./kimi-workflow.cjs');

const PROVIDER_ID = 'opencode-go';
const MODEL_ID = 'opencode-go/deepseek-v4.1-flash';
const STUDIO_DEFAULT = Object.freeze({ provider: PROVIDER_ID, model: MODEL_ID, thinking: 'on', effort: 'low' });

function studioCatalog(raw) {
  const model = raw.models.find(item => item.id === MODEL_ID && item.provider === PROVIDER_ID);
  const provider = raw.providers.find(item => item.id === PROVIDER_ID);
  if (!model || !provider) throw new Error('角色工坊需要 Kimi 配置中的 opencode-go / DeepSeek V4.1 Flash，请检查该模型配置。');
  return { ...raw, default_model: MODEL_ID, fixed_model: true,
    providers: [{ ...provider, model_count: 1 }], models: [{ ...model }] };
}

function studioSelection(catalog, raw) {
  const requested = normalizeSelection(raw);
  if ((requested.provider && requested.provider !== PROVIDER_ID) || (requested.model && requested.model !== MODEL_ID))
    throw new Error('角色工坊助手只使用 DeepSeek V4.1 Flash。');
  const selected = { ...requested, provider: PROVIDER_ID, model: MODEL_ID };
  resolveSelection(catalog, selected);
  return selected;
}

function adoptedSelection(catalog, saved) {
  if (saved.provider !== PROVIDER_ID || saved.model !== MODEL_ID) return { ...STUDIO_DEFAULT };
  try { return studioSelection(catalog, saved); }
  catch { return { ...STUDIO_DEFAULT }; }
}

class StudioKimiRunner extends KimiRunner {
  constructor(bridge, emit, providers = null) {
    super(bridge, emit);
    this.providers = providers;
  }

  async catalog() {
    if (this.providers) {
      await this.providers.autoMetadata();
      const catalog = this.providers.catalog();
      const selection = this.providers.selection(catalog);
      return { ...catalog, selection };
    }
    const catalog = studioCatalog(runCatalog(this.bridge.root));
    const saved = readSelection(this.bridge.data);
    const selection = adoptedSelection(catalog, saved);
    if (JSON.stringify(selection) !== JSON.stringify(saved)) saveSelection(this.bridge.data, selection);
    return { ...catalog, selection };
  }

  async setSelection(raw) {
    if (this.run || this.process) throw new Error('Kimi 正在处理任务，完成或停止后再调整思考设置。');
    if (this.providers) {
      const catalog = this.providers.catalog();
      let selection = normalizeSelection(raw);
      const resolved = resolveSelection(catalog, selection);
      if (!resolved.entry) throw new Error('请先启用一个模型。');
      selection = { ...selection, provider: resolved.provider || resolved.entry.provider, model: resolved.model || resolved.entry.id };
      if (resolved.entry?.tool_use === false) throw new Error('该模型不支持工具调用，无法执行角色生成。');
      saveSelection(this.bridge.data, selection);
      return { ...catalog, selection };
    }
    const catalog = studioCatalog(runCatalog(this.bridge.root));
    const selection = studioSelection(catalog, raw);
    saveSelection(this.bridge.data, selection);
    return { ...catalog, selection };
  }

  resolveForRun(raw) {
    if (this.providers) {
      const catalog = this.providers.catalog();
      let requested = raw ? normalizeSelection(raw) : this.providers.selection(catalog);
      let resolved = resolveSelection(catalog, requested);
      if (!resolved.entry) throw new Error('请先在模型管理中添加、启用并选择模型。');
      requested = { ...requested, provider: resolved.provider || resolved.entry.provider, model: resolved.model || resolved.entry.id };
      resolved = resolveSelection(catalog, requested);
      if (resolved.entry.tool_use === false) throw new Error('该模型不支持工具调用，无法执行角色生成。');
      return { catalog, requested, resolved, thinking: planThinking(catalog, resolved),
        provider: { ...findProvider(catalog, resolved.provider), type: resolved.entry.protocol || findProvider(catalog, resolved.provider)?.type } };
    }
    const catalog = studioCatalog(runCatalog(this.bridge.root));
    const requested = raw ? studioSelection(catalog, raw) : adoptedSelection(catalog, readSelection(this.bridge.data));
    const resolved = resolveSelection(catalog, requested);
    return { catalog, requested, resolved, thinking: planThinking(catalog, resolved), provider: findProvider(catalog, PROVIDER_ID) };
  }

  prepareRuntime(selection, thinking, folder) {
    return this.providers?.prepareRuntime(selection, thinking, folder) || null;
  }

  async start(request = {}) {
    if (request.mode && request.mode !== 'execute') throw new Error('角色工坊助手只执行生成，请选择执行步骤。');
    const stages = executionStages(request.stages);
    await this.providers?.autoMetadata();
    return super.start({ ...request, mode: 'execute', stages });
  }
}

module.exports = { StudioKimiRunner, studioCatalog, studioSelection, adoptedSelection, PROVIDER_ID, MODEL_ID, STUDIO_DEFAULT };
