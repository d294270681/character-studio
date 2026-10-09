import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import '../provider-manager.css';

const EMPTY_FORM = { id: '', label: '', endpoint: '', api_key: '', protocol: 'openai' };

const PROTOCOLS = [
  { value: 'openai', label: 'OpenAI Chat Completions' },
  { value: 'anthropic', label: 'Anthropic Messages' },
  { value: 'openai_responses', label: 'OpenAI Responses' },
];

const EFFORT_CHOICES = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_ZH = { none: '无', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大' };

const SOURCE_LABEL = { endpoint: '接口读取', kimi_config: 'Kimi 配置', 'kimi-config': 'Kimi 配置',
  kimi_override: 'Kimi 手动配置', models_dev: '服务商目录', model_reference: '模型参考规格',
  manual: '手动填写', combined: '自动适配' };

const TRI_UNKNOWN = 'unknown';

function normalizeProtocol(value) {
  return ['anthropic', 'openai_responses'].includes(value) ? value : 'openai';
}

function protocolShort(value) {
  return normalizeProtocol(value) === 'anthropic' ? 'Anthropic' : value === 'openai_responses' ? 'Responses' : 'OpenAI';
}

function hostOf(endpoint) {
  if (!endpoint) return '';
  try {
    return new URL(endpoint).host;
  } catch {
    return String(endpoint).replace(/^https?:\/\//i, '').split('/')[0];
  }
}

function effortLabel(id) {
  const zh = EFFORT_ZH[id];
  return zh ? `${zh} (${id})` : String(id);
}

function modelNativeId(model) {
  return model?.model || model?.id || '';
}

function modelTitle(model) {
  return model?.label || model?.model || model?.id || '';
}

function sourceLabel(source) {
  if (!source || source === 'unknown') return '';
  return SOURCE_LABEL[source] || String(source);
}

function fieldSource(model, field) {
  const map = model?.metadata_sources;
  if (!map || typeof map !== 'object') return '';
  return sourceLabel(map[field]);
}

function triFromBool(value) {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  return TRI_UNKNOWN;
}

function boolFromTri(value) {
  if (value === 'yes') return true;
  if (value === 'no') return false;
  return null;
}

function numberOrNull(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function draftFromModel(model) {
  return {
    enabled: model.enabled !== false,
    tool_use: model.tool_use ?? null,
    image_in: model.image_in ?? null,
    thinking_supported: model.thinking_supported ?? null,
    support_efforts: Array.isArray(model.support_efforts) ? [...model.support_efforts] : null,
    max_context_size: Number.isFinite(model.max_context_size) ? model.max_context_size : null,
    max_input_tokens: Number.isFinite(model.max_input_tokens) ? model.max_input_tokens : null,
    max_output_tokens: Number.isFinite(model.max_output_tokens) ? model.max_output_tokens : null,
  };
}

function capabilityChips(model) {
  const chips = [];
  if (model.tool_use === true) chips.push({ key: 'tool', text: '工具调用' });
  else if (model.tool_use === false) chips.push({ key: 'tool', text: '无工具调用', bad: true });
  if (model.image_in === true) chips.push({ key: 'image', text: '可读图' });
  else if (model.image_in === false) chips.push({ key: 'image', text: '不可读图', bad: true });
  if (model.thinking_supported === true) chips.push({ key: 'think', text: '支持思考' });
  else if (model.thinking_supported === false) chips.push({ key: 'think', text: '无思考', bad: true });
  return chips;
}

function capsUnknown(model) {
  return model.tool_use == null && model.image_in == null && model.thinking_supported == null;
}

function TriField({ id, label, hint, unknownHint, value, source, disabled, onChange, onUnknown }) {
  const chip = source ? `来源：${source}` : value == null ? '未确认' : '';
  return (
    <div
      className="pm-field"
      onContextMenu={event => { event.preventDefault(); onUnknown(); }}
      title="右键可标记为未确认"
    >
      <span className="pm-field-head">
        <label className="pm-label" htmlFor={id}>{label}</label>
        {chip && <span className={`pm-tag${source ? ' src' : ' unknown'}`}>{chip}</span>}
      </span>
      <span className="pm-select">
        <select
          id={id}
          value={triFromBool(value)}
          onChange={event => onChange(boolFromTri(event.target.value))}
          disabled={disabled}
        >
          <option value={TRI_UNKNOWN}>未确认</option>
          <option value="yes">支持</option>
          <option value="no">不支持</option>
        </select>
        <Icon name="chevronDown" size={14} className="pm-caret" />
      </span>
      <span className="pm-hint">{value == null && unknownHint ? unknownHint : hint}</span>
    </div>
  );
}

export default function ProviderManager({
  open, onClose, running, busy: busyProp, disabled, onChanged, onApplied,
}) {
  const uid = useId();
  const titleId = `${uid}-title`;

  const [state, setState] = useState(null);
  const [activeId, setActiveId] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [query, setQuery] = useState('');
  const [manualId, setManualId] = useState('');
  const [modelId, setModelId] = useState('');
  const [draft, setDraft] = useState(null);
  const [effortsEditing, setEffortsEditing] = useState(false);
  const [customEffort, setCustomEffort] = useState('');
  const [thinking, setThinking] = useState('default');
  const [effort, setEffort] = useState('default');
  const [pending, setPending] = useState('');
  const [flash, setFlash] = useState(null);
  const [test, setTest] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const dialogRef = useRef(null);
  const restoreRef = useRef(null);
  const formDirtyRef = useRef(false);
  const draftDirtyRef = useRef(false);
  const draftKeyRef = useRef('');
  const busyOnlyRef = useRef(false);

  const callbacksRef = useRef({ onChanged, onApplied });
  callbacksRef.current = { onChanged, onApplied };

  const busy = pending !== '';
  const externallyBusy = !!busyProp || !!disabled || !!running;
  const locked = busy || externallyBusy;
  busyOnlyRef.current = busy;

  const providers = state?.providers || [];
  const active = providers.find(item => item.id === activeId) || null;
  const models = useMemo(() => active?.models || [], [active]);
  const selectedModel = useMemo(() => models.find(item => item.id === modelId) || null, [models, modelId]);
  const nativeId = modelNativeId(selectedModel);
  const readonly = !!active?.readonly;

  const selection = state?.selection || {};
  const isSelectedModel = !!selectedModel
    && selection.provider === activeId
    && (selection.model === nativeId || selection.model === selectedModel.id);

  const notifyChanged = useCallback(result => {
    try { callbacksRef.current.onChanged?.(result); } catch { /* parent callback */ }
    try { callbacksRef.current.onApplied?.(result); } catch { /* parent callback */ }
  }, []);

  const request = useCallback((action, payload) => {
    const fn = typeof window !== 'undefined' ? window.studio?.providerAction : null;
    if (typeof fn !== 'function') {
      throw new Error('当前版本的后端还没有提供模型连接接口，请更新角色工坊后再试。');
    }
    return fn(action, payload);
  }, []);

  const runAction = useCallback(async ({ key, action, payload, success, changed }) => {
    setPending(key);
    setFlash(null);
    try {
      const result = await request(action, payload);
      if (result && Array.isArray(result.providers)) setState(result);
      if (result?.test) setTest(result.test);
      if (result?.notice) setFlash({ kind: 'info', text: String(result.notice) });
      else if (success) setFlash({ kind: 'success', text: success });
      if (changed) notifyChanged(result);
      return result;
    } catch (err) {
      const message = err && err.message ? String(err.message) : String(err);
      setFlash({ kind: 'error', text: message });
      return null;
    } finally {
      setPending('');
    }
  }, [notifyChanged, request]);

  // ---- open / close lifecycle -------------------------------------------

  useEffect(() => {
    if (!open) return undefined;
    restoreRef.current = document.activeElement;
    const node = dialogRef.current;
    if (node) node.focus();
    const onKeyDown = event => {
      if (event.key !== 'Escape') return;
      if (busyOnlyRef.current) {
        event.stopPropagation();
        return;
      }
      event.stopPropagation();
      onClose?.();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      const previous = restoreRef.current;
      if (previous && typeof previous.focus === 'function' && document.contains(previous)) previous.focus();
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    setFlash(null);
    setTest(null);
    setQuery('');
    setManualId('');
    setCreating(false);
    setConfirmRemove(false);
    setPending('');
    formDirtyRef.current = false;
    draftDirtyRef.current = false;
    runAction({ key: 'list', action: 'list' });
  }, [open, runAction]);

  // ---- derived sync ------------------------------------------------------

  useEffect(() => {
    if (!open || creating) return;
    if (!providers.length) {
      if (activeId) setActiveId('');
      return;
    }
    if (!providers.some(item => item.id === activeId)) setActiveId(providers[0].id);
  }, [open, creating, providers, activeId]);

  useEffect(() => {
    if (!open) return;
    if (creating) {
      if (!formDirtyRef.current) setForm(EMPTY_FORM);
      return;
    }
    if (formDirtyRef.current) return;
    setForm(active
      ? {
        id: active.id,
        label: active.label || '',
        endpoint: active.endpoint || '',
        api_key: '',
        protocol: normalizeProtocol(active.protocol),
      }
      : EMPTY_FORM);
  }, [open, creating, active]);

  useEffect(() => {
    if (!open) return;
    setConfirmRemove(false);
    setManualId('');
    if (!models.length) {
      if (modelId) setModelId('');
      return;
    }
    const preferred = models.find(item => selection.provider === activeId
      && (selection.model === modelNativeId(item) || selection.model === item.id)) || models[0];
    setModelId(current => (models.some(item => item.id === current) ? current : preferred.id));
  }, [open, activeId, models, modelId, selection.provider, selection.model]);

  useEffect(() => {
    if (!open) return;
    const key = `${activeId}::${modelId}`;
    const sameModel = draftKeyRef.current === key;
    draftKeyRef.current = key;
    if (!sameModel) setTest(null);
    if (!selectedModel) {
      setDraft(null);
      setEffortsEditing(false);
      return;
    }
    if (sameModel && draftDirtyRef.current) return;
    setDraft(draftFromModel(selectedModel));
    setEffortsEditing(Array.isArray(selectedModel.support_efforts));
    setCustomEffort('');
    if (!sameModel) draftDirtyRef.current = false;
  }, [open, activeId, modelId, selectedModel]);

  useEffect(() => {
    if (!open) return;
    if (isSelectedModel) {
      setThinking(selection.thinking || 'default');
      setEffort(selection.effort || 'default');
    } else {
      setThinking('default');
      setEffort('default');
    }
  }, [open, isSelectedModel, selection.thinking, selection.effort]);

  // ---- actions -----------------------------------------------------------

  const startNew = () => {
    setCreating(true);
    setFormError('');
    formDirtyRef.current = false;
    setForm(EMPTY_FORM);
    setActiveId('');
  };

  const pickProvider = id => {
    setCreating(false);
    setFormError('');
    formDirtyRef.current = false;
    setActiveId(id);
  };

  const patchForm = (field, value) => {
    formDirtyRef.current = true;
    setForm(current => ({ ...current, [field]: value }));
  };

  const saveProvider = async () => {
    const label = form.label.trim();
    const endpoint = form.endpoint.trim();
    if (!label) { setFormError('请填写连接名称。'); return; }
    if (!/^https?:\/\//i.test(endpoint)) { setFormError('Endpoint 需要以 http:// 或 https:// 开头。'); return; }
    setFormError('');
    const payload = { label, endpoint, protocol: normalizeProtocol(form.protocol) };
    if (form.id) payload.id = form.id;
    const key = form.api_key.trim();
    if (key) payload.api_key = key;
    const before = new Set(providers.map(item => item.id));
    const result = await runAction({
      key: 'save',
      action: 'save',
      payload,
      changed: true,
    });
    if (!result) return;
    const list = result.providers || [];
    const createdId = result.saved_provider_id
      || (form.id ? form.id : ((list.find(item => !before.has(item.id)) || {}).id));
    formDirtyRef.current = false;
    setCreating(false);
    if (createdId) setActiveId(createdId);
    else if (!form.id && list.length) setActiveId(list[list.length - 1].id);
    if (createdId) {
      await runAction({ key: 'discover', action: 'discover', payload: { provider_id: createdId }, changed: true });
    } else setFlash({ kind: 'success', text: form.id ? '已保存连接设置。' : '已新增连接。' });
  };

  const removeProvider = async () => {
    if (!activeId || readonly) return;
    setConfirmRemove(false);
    const result = await runAction({
      key: 'remove',
      action: 'remove',
      payload: { provider_id: activeId },
      changed: true,
    });
    if (!result) return;
    formDirtyRef.current = false;
    const list = result.providers || [];
    if (!list.some(item => item.id === activeId)) setActiveId(list.length ? list[0].id : '');
    setFlash({ kind: 'success', text: '已删除这个自建连接。' });
  };

  const discoverModels = async () => {
    if (!activeId) return;
    const result = await runAction({
      key: 'discover',
      action: 'discover',
      payload: { provider_id: activeId },
      changed: true,
    });
    if (!result) return;
    const total = (result.providers || []).find(item => item.id === activeId)?.models?.length ?? 0;
    setFlash({
      kind: 'success',
      text: total
        ? `已拉取 ${total} 个模型，并自动匹配思考等级、输入输出限制和能力。`
        : '接口没有返回模型，可以手动填写原生模型 ID。',
    });
  };

  const syncMetadata = () => activeId && runAction({ key: 'sync_metadata', action: 'sync_metadata',
    payload: { provider_id: activeId }, changed: true });
  const resetMetadata = () => selectedModel && runAction({ key: 'reset_metadata', action: 'reset_metadata',
    payload: { provider_id: activeId, model_id: selectedModel.id }, changed: true });

  const addModel = async () => {
    const native = manualId.trim();
    if (!native || !activeId) return;
    const result = await runAction({
      key: 'add_model',
      action: 'add_model',
      payload: { provider_id: activeId, model: native, label: native, values: { enabled: true } },
      changed: true,
    });
    if (!result) return;
    setManualId('');
    const added = (result.providers || []).find(item => item.id === activeId)?.models
      ?.find(item => modelNativeId(item) === native);
    if (added) {
      draftKeyRef.current = '';
      setModelId(added.id);
    }
    setFlash({ kind: 'success', text: `已添加模型 ${native}，能力参数未确认时不会猜。` });
  };

  const patchDraft = patch => {
    draftDirtyRef.current = true;
    setDraft(current => (current ? { ...current, ...patch } : current));
  };

  // Right-click any capability control to drop it back to "未确认" instead of guessing.
  const markUnknown = field => {
    if (locked || !draft) return;
    if (field === 'support_efforts') {
      setEffortsEditing(false);
      patchDraft({ support_efforts: null });
      return;
    }
    patchDraft({ [field]: null });
  };

  const toggleEffort = value => {
    const current = Array.isArray(draft?.support_efforts) ? draft.support_efforts : [];
    const next = current.includes(value) ? current.filter(item => item !== value) : [...current, value];
    patchDraft({ support_efforts: next });
  };

  const startEffortEditing = () => {
    setEffortsEditing(true);
    patchDraft({ support_efforts: [] });
  };

  const addCustomEffort = () => {
    const value = customEffort.trim();
    if (!value) return;
    const current = Array.isArray(draft?.support_efforts) ? draft.support_efforts : [];
    if (!current.includes(value)) patchDraft({ support_efforts: [...current, value] });
    setCustomEffort('');
  };

  const saveModelParams = async ({ enabledOnly = false } = {}) => {
    if (!draft || !selectedModel || !activeId || !nativeId) return;
    // `enabled` toggles alone; capability values are sent only from the params form
    // so a switch flip never rewrites capabilities the user has not reviewed.
    const values = enabledOnly ? { enabled: !draft.enabled } : { ...draft };
    const result = await runAction({
      key: 'update_model',
      action: 'update_model',
      payload: { provider_id: activeId, model_id: selectedModel.id, native_id: nativeId, values },
      changed: true,
    });
    if (!result) return;
    draftDirtyRef.current = false;
    setFlash({
      kind: 'success',
      text: enabledOnly
        ? (values.enabled ? '已启用这个模型。' : '已停用这个模型。')
        : '已保存模型参数。',
    });
  };

  const probeModel = async () => {
    if (!activeId || !nativeId) return;
    const result = await runAction({
      key: 'probe',
      action: 'probe',
      payload: { provider_id: activeId, model_id: selectedModel?.id, native_id: nativeId },
    });
    if (!result) return;
    const outcome = result.test;
    setFlash(outcome
      ? { kind: outcome.passed ? 'success' : 'error', text: outcome.message || (outcome.passed ? '工具调用通过。' : '工具调用未通过。') }
      : { kind: 'info', text: '测试完成，但没有返回结果。' });
  };

  const selectModel = async (nextThinking, nextEffort, announce = true) => {
    if (!activeId || !nativeId || !selectedModel) return null;
    const result = await runAction({
      key: 'select',
      action: 'select',
      payload: {
        provider_id: activeId,
        model_id: selectedModel.id,
        native_id: nativeId,
        thinking: nextThinking ?? thinking,
        effort: nextEffort ?? effort,
      },
      changed: true,
    });
    if (!result) return null;
    setFlash({ kind: 'success', text: announce ? `已选用 ${modelTitle(selectedModel)}。` : `已更新思考设置。` });
    return result;
  };

  const changeThinking = value => {
    setThinking(value);
    if (value === 'off') setEffort('default');
    if (isSelectedModel) selectModel(value, value === 'off' ? 'default' : effort, false);
  };

  const changeEffort = value => {
    setEffort(value);
    if (isSelectedModel) selectModel(thinking, value, false);
  };

  // ---- render ------------------------------------------------------------

  if (!open) return null;

  const text = query.trim().toLowerCase();
  const filtered = text
    ? models.filter(item => [item.label, item.model, item.id].some(value => String(value || '').toLowerCase().includes(text)))
    : models;

  const pendingLabel = {
    list: '正在读取连接…',
    save: '正在保存连接…',
    remove: '正在删除连接…',
    discover: '正在拉取模型…',
    add_model: '正在添加模型…',
    update_model: '正在保存参数…',
    probe: '正在测试工具调用…',
    sync_metadata: '正在更新模型规格…',
    reset_metadata: '正在恢复自动规格…',
    select: '正在选用模型…',
  }[pending] || '';

  const selectedProvider = providers.find(item => item.id === selection.provider);
  const selectedEntry = (selectedProvider?.models || []).find(item => modelNativeId(item) === selection.model || item.id === selection.model);
  const selectionSummary = selection.provider
    ? `当前选用：${selectedProvider?.label || selection.provider} · ${selectedEntry ? modelTitle(selectedEntry) : selection.model}`
    : '当前跟随 Kimi 默认模型';

  const supportEfforts = Array.isArray(draft?.support_efforts) ? draft.support_efforts : [];
  const unknownEfforts = !Array.isArray(draft?.support_efforts);
  const unavailableEfforts = (selectedModel?.declared_efforts || []).filter(value => !EFFORT_CHOICES.includes(value));

  return (
    <div
      className="pm-backdrop"
      onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose?.(); }}
    >
      <div
        className="pm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        tabIndex={-1}
        data-testid="provider-manager"
      >
        <header className="pm-head">
          <span className="pm-title" id={titleId}>
            <Icon name="cpu" size={18} />
            模型连接平台
          </span>
          {pendingLabel && (
            <span className="pm-pending" role="status">
              <span className="pm-spinner" aria-hidden="true" />
              {pendingLabel}
            </span>
          )}
          <button
            type="button"
            className="icon-btn"
            title="关闭"
            aria-label="关闭模型连接平台"
            onClick={() => !busy && onClose?.()}
            disabled={busy}
          >
            <Icon name="close" size={16} />
          </button>
        </header>

        {externallyBusy && (
          <p className="pm-lockbar" role="status">
            <Icon name="alert" size={14} />
            <span>角色工坊正在执行任务，连接的保存、测试与选用暂时锁定。</span>
          </p>
        )}

        {flash && (
          <p className={`pm-flash ${flash.kind}`} role="status">
            <Icon name={flash.kind === 'error' ? 'alert' : 'check'} size={14} />
            <span>{flash.text}</span>
          </p>
        )}

        <div className="pm-body">
          <aside className="pm-col pm-providers" aria-label="连接列表">
            <div className="pm-col-head">
              <span className="pm-col-title">连接</span>
              <button type="button" className="btn ghost small" onClick={startNew} disabled={busy}>
                <Icon name="plus" size={14} />
                <span>新增</span>
              </button>
            </div>
            <div className="pm-scroll">
              {!providers.length && (
                <p className="pm-empty">
                  还没有模型连接。点"新增"填写 Endpoint 与 API Key，保存后即可拉取模型。
                </p>
              )}
              {providers.map(item => (
                <button
                  key={item.id}
                  type="button"
                  className={`pm-provider${!creating && item.id === activeId ? ' is-active' : ''}`}
                  onClick={() => pickProvider(item.id)}
                  aria-pressed={!creating && item.id === activeId}
                >
                  <span className="pm-provider-name">{item.label || item.id}</span>
                  <span className="pm-provider-host">{hostOf(item.endpoint) || '未填写 Endpoint'}</span>
                  <span className="pm-provider-tags">
                    <span className="pm-tag">{protocolShort(item.protocol)}</span>
                    <span className="pm-tag">{(item.models || []).length} 个模型</span>
                    {item.readonly && <span className="pm-tag">只读</span>}
                    {item.has_key === false && <span className="pm-tag warn">缺 Key</span>}
                  </span>
                </button>
              ))}
            </div>
          </aside>

          <section className="pm-col pm-models" aria-label="模型列表">
            <div className="pm-col-head">
              <span className="pm-col-title">模型</span>
              <button
                type="button"
                className="btn accent small"
                onClick={discoverModels}
                disabled={!activeId || busy}
                      title="读取模型列表，并自动适配思考等级、输入输出限制和能力"
              >
                <Icon name="refresh" size={14} />
                <span>拉取模型</span>
              </button>
            </div>
            <div className="pm-search">
              <input
                className="text-input"
                type="text"
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="按名称或模型 ID 筛选"
                aria-label="筛选模型"
              />
            </div>
            <div className="pm-scroll">
              {!activeId && <p className="pm-empty">先选择一个连接，或新增一个。</p>}
              {!!activeId && !models.length && (
                <p className="pm-empty">
                  这个连接还没有模型。点"拉取模型"读取接口列表，或直接在下方手动填写原生模型 ID。
                </p>
              )}
              {!!activeId && !!models.length && !filtered.length && <p className="pm-empty">没有匹配的模型。</p>}
              {filtered.map(item => {
                const chips = capabilityChips(item);
                const isCurrent = selection.provider === activeId
                  && (selection.model === modelNativeId(item) || selection.model === item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`pm-model${item.id === modelId ? ' is-active' : ''}${item.enabled === false ? ' is-off' : ''}`}
                    onClick={() => setModelId(item.id)}
                    aria-pressed={item.id === modelId}
                  >
                    <span className="pm-model-top">
                      <span className="pm-model-name">{modelTitle(item)}</span>
                      {isCurrent && <Icon name="check" size={14} className="pm-model-check" />}
                    </span>
                    {item.model && item.model !== modelTitle(item) && <span className="pm-model-native">{item.model}</span>}
                    <span className="pm-model-tags">
                      {item.enabled === false && <span className="pm-tag">未启用</span>}
                      {chips.map(chip => (
                        <span key={chip.key} className={`pm-tag${chip.bad ? ' bad' : ' ok'}`}>{chip.text}</span>
                      ))}
                      {capsUnknown(item) && <span className="pm-tag unknown">未确认</span>}
                    </span>
                  </button>
                );
              })}
            </div>
            {!!activeId && (
              <div className="pm-addmodel">
                <label className="pm-field">
                  <span className="pm-label">手动添加原生模型 ID</span>
                  <input
                    className="text-input"
                    type="text"
                    value={manualId}
                    onChange={event => setManualId(event.target.value)}
                    onKeyDown={event => { if (event.key === 'Enter') addModel(); }}
                    placeholder="例如 deepseek-v4.1-flash"
                    spellCheck="false"
                    disabled={locked}
                  />
                </label>
                <button
                  type="button"
                  className="btn small"
                  onClick={addModel}
                  disabled={locked || !manualId.trim()}
                >
                  <Icon name="plus" size={14} />
                  <span>添加</span>
                </button>
              </div>
            )}
          </section>

          <section className="pm-col pm-detail" aria-label="连接与模型设置">
            <div className="pm-scroll">
              <div className="pm-section">
                <div className="pm-section-head">
                  <span className="pm-col-title">{creating ? '新增连接' : '连接设置'}</span>
                  {!creating && readonly && <span className="pm-tag">只读连接</span>}
                </div>

                <div className="pm-grid2">
                  <label className="pm-field">
                    <span className="pm-label">连接名称</span>
                    <input
                      className="text-input"
                      type="text"
                      value={form.label}
                      onChange={event => patchForm('label', event.target.value)}
                      placeholder="例如 OpenCode Go"
                      aria-label="连接名称"
                      disabled={readonly || busy}
                    />
                  </label>
                  <label className="pm-field">
                    <span className="pm-label">协议</span>
                    <span className="pm-select">
                      <select
                        value={normalizeProtocol(form.protocol)}
                        onChange={event => patchForm('protocol', event.target.value)}
                        disabled={readonly || busy}
                        aria-label="接口协议"
                      >
                        {PROTOCOLS.map(item => (
                          <option key={item.value} value={item.value}>{item.label}</option>
                        ))}
                      </select>
                      <Icon name="chevronDown" size={14} className="pm-caret" />
                    </span>
                  </label>
                </div>

                <label className="pm-field">
                  <span className="pm-label">Endpoint</span>
                  <input
                    className="text-input"
                    type="url"
                    value={form.endpoint}
                    onChange={event => patchForm('endpoint', event.target.value)}
                    placeholder="https://api.example.com/v1"
                    spellCheck="false"
                    autoComplete="off"
                    aria-label="Endpoint"
                    disabled={readonly || busy}
                  />
                </label>

                <label className="pm-field">
                  <span className="pm-label">API Key</span>
                  <input
                    className="text-input"
                    type="password"
                    value={form.api_key}
                    onChange={event => patchForm('api_key', event.target.value)}
                    placeholder={active?.has_key ? '已保存，留空表示保持不变' : '粘贴 API Key'}
                    spellCheck="false"
                    autoComplete="new-password"
                    aria-label="API Key"
                    disabled={readonly || busy}
                  />
                  <span className="pm-hint">密钥只用于本地调用，界面不会回读已保存的明文。</span>
                </label>

                {formError && <p className="pm-inline-error" role="alert">{formError}</p>}

                <div className="pm-actions">
                  <button
                    type="button"
                    className="btn primary small"
                    onClick={saveProvider}
                    disabled={readonly || busy}
                  >
                    <Icon name="save" size={15} />
                    <span>{form.id ? '保存连接' : '新增连接'}</span>
                  </button>
                  {!readonly && !!form.id && (confirmRemove ? (
                    <>
                      <button type="button" className="btn danger small" onClick={removeProvider} disabled={busy}>
                        确认删除
                      </button>
                      <button type="button" className="btn ghost small" onClick={() => setConfirmRemove(false)} disabled={busy}>
                        取消
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => setConfirmRemove(true)}
                      disabled={busy}
                    >
                      <Icon name="minus" size={14} />
                      <span>删除连接</span>
                    </button>
                  ))}
                  {readonly && <span className="pm-hint">这是角色工坊导入的只读连接，不能改地址、换 Key 或删除。</span>}
                </div>
              </div>

              <div className="pm-section">
                <div className="pm-section-head">
                  <span className="pm-col-title">模型参数</span>
                  <button type="button" className="btn ghost small" onClick={syncMetadata} disabled={locked || !activeId}
                    title="更新服务列表与模型目录，并保留手动设置"><Icon name="refresh" size={13} />刷新规格</button>
                  {selectedModel?.metadata_source && (
                    <span className="pm-tag">来源：{sourceLabel(selectedModel.metadata_source)}</span>
                  )}
                </div>

                {!selectedModel && <p className="pm-empty">从中间的列表里选一个模型，再设置它的能力与参数。</p>}

                {selectedModel && draft && (
                  <>
                    <div className="pm-model-head">
                      <div className="pm-model-head-text">
                        <strong>{modelTitle(selectedModel)}</strong>
                        <code>{selectedModel.model || selectedModel.id}</code>
                      </div>
                      <button
                        type="button"
                        className={`pm-switch${draft.enabled ? ' is-on' : ''}`}
                        onClick={() => saveModelParams({ enabledOnly: true })}
                        disabled={locked}
                        role="switch"
                        aria-checked={draft.enabled}
                        aria-label={draft.enabled ? '停用这个模型' : '启用这个模型'}
                        title={draft.enabled ? '停用这个模型' : '启用这个模型'}
                      >
                        <span className="pm-switch-track"><span className="pm-switch-knob" /></span>
                        <span className="pm-switch-text">{draft.enabled ? '已启用' : '未启用'}</span>
                      </button>
                    </div>

                    <p className="pm-hint pm-auto-note" data-testid="metadata-auto-status">
                      {state?.catalog_status?.notice || (Object.values(selectedModel.metadata_sources || {}).includes('model_reference')
                        ? '服务商未匹配，采用厂家参考规格；实际服务可能另有限制。' : '服务接口优先，目录自动补全；手动设置优先保留。')}
                      {selectedModel.protocol && <span className="pm-tag">使用 {protocolShort(selectedModel.protocol)} 协议</span>}
                    </p>

                    {draft.enabled === false && (
                      <p className="pm-hint">这个模型还没有启用，选用前先打开右上角的开关。</p>
                    )}

                    <div className="pm-grid2">
                      <TriField
                        id={`${uid}-tool-use`}
                        label="工具调用"
                        hint="助手用工具读取项目、填写参数并启动生成。"
                        unknownHint="未确认时不会按模型名推测。"
                        value={draft.tool_use}
                        source={fieldSource(selectedModel, 'tool_use')}
                        disabled={locked}
                        onChange={next => patchDraft({ tool_use: next })}
                        onUnknown={() => markUnknown('tool_use')}
                      />
                      <TriField
                        id={`${uid}-image-in`}
                        label="图像输入"
                        hint="决定助手能否读取参考图。"
                        unknownHint="未确认时不当作可读图。"
                        value={draft.image_in}
                        source={fieldSource(selectedModel, 'image_in')}
                        disabled={locked}
                        onChange={next => patchDraft({ image_in: next })}
                        onUnknown={() => markUnknown('image_in')}
                      />
                      <TriField
                        id={`${uid}-thinking`}
                        label="思考能力"
                        hint="决定思考模式与等级是否可选。"
                        unknownHint="未确认时思考设置保持可选。"
                        value={draft.thinking_supported}
                        source={fieldSource(selectedModel, 'thinking_supported')}
                        disabled={locked}
                        onChange={next => patchDraft({ thinking_supported: next })}
                        onUnknown={() => markUnknown('thinking_supported')}
                      />
                      <label className="pm-field" title="右键可标记为未确认">
                        <span className="pm-field-head">
                          <span className="pm-label">上限上下文（tokens）</span>
                          {fieldSource(selectedModel, 'max_context_size')
                            && <span className="pm-tag src">{`来源：${fieldSource(selectedModel, 'max_context_size')}`}</span>}
                        </span>
                        <input
                          className="text-input"
                          type="text"
                          inputMode="numeric"
                          value={draft.max_context_size == null ? '' : String(draft.max_context_size)}
                          onChange={event => patchDraft({ max_context_size: numberOrNull(event.target.value) })}
                          onContextMenu={event => { event.preventDefault(); markUnknown('max_context_size'); }}
                          placeholder="未确认"
                          aria-label="上限上下文（tokens）"
                          disabled={locked}
                        />
                      </label>
                      <label className="pm-field" title="右键可标记为未确认">
                        <span className="pm-field-head">
                          <span className="pm-label">上限输入（tokens）</span>
                          {fieldSource(selectedModel, 'max_input_tokens')
                            && <span className="pm-tag src">{`来源：${fieldSource(selectedModel, 'max_input_tokens')}`}</span>}
                        </span>
                        <input className="text-input" type="text" inputMode="numeric" aria-label="上限输入（tokens）"
                          value={draft.max_input_tokens == null ? '' : String(draft.max_input_tokens)}
                          onChange={event => patchDraft({ max_input_tokens: numberOrNull(event.target.value) })}
                          onContextMenu={event => { event.preventDefault(); markUnknown('max_input_tokens'); }}
                          placeholder="未单独声明，自动按上下文预算" disabled={locked} />
                      </label>
                      <label className="pm-field" title="右键可标记为未确认">
                        <span className="pm-field-head">
                          <span className="pm-label">上限输出（tokens）</span>
                          {fieldSource(selectedModel, 'max_output_tokens')
                            && <span className="pm-tag src">{`来源：${fieldSource(selectedModel, 'max_output_tokens')}`}</span>}
                        </span>
                        <input
                          className="text-input"
                          type="text"
                          inputMode="numeric"
                          value={draft.max_output_tokens == null ? '' : String(draft.max_output_tokens)}
                          onChange={event => patchDraft({ max_output_tokens: numberOrNull(event.target.value) })}
                          onContextMenu={event => { event.preventDefault(); markUnknown('max_output_tokens'); }}
                          placeholder="未确认"
                          aria-label="上限输出（tokens）"
                          disabled={locked}
                        />
                      </label>
                    </div>

                    <div className="pm-budget" data-testid="model-input-budget">
                      <span>自动输入预算 <strong>{selectedModel.input_budget?.toLocaleString()}</strong></span>
                      <span>预留输出 <strong>{selectedModel.reserved_output_tokens?.toLocaleString()}</strong></span>
                    </div>
                    <p className="pm-hint block">上下文包含输入与输出。未单独声明输入上限时，按上下文预留输出空间计算预算；该预算用于助手的上下文控制。当前 Kimi 仅在 Anthropic 请求中使用输出上限。</p>

                    <div className="pm-extra-capabilities" aria-label="其他模型能力">
                      {[['video_in', '视频输入'], ['audio_in', '音频输入'], ['pdf_in', 'PDF 输入'],
                        ['structured_output', '结构化输出'], ['temperature', '温度参数']].map(([field, label]) => (
                        <span key={field} className={`pm-extra-cap ${selectedModel[field] === true ? 'ok' : ''}`}
                          title={fieldSource(selectedModel, field) ? `来源：${fieldSource(selectedModel, field)}` : '没有能力声明'}>
                          {label}<b>{selectedModel[field] === true ? '支持' : selectedModel[field] === false ? '不支持' : '未确认'}</b>
                        </span>
                      ))}
                    </div>

                    <div
                      className="pm-field"
                      onContextMenu={event => { event.preventDefault(); markUnknown('support_efforts'); }}
                      title="右键可标记为未确认"
                    >
                      <span className="pm-field-head">
                        <span className="pm-label">支持的思考等级</span>
                        {fieldSource(selectedModel, 'support_efforts')
                          && <span className="pm-tag src">{`来源：${fieldSource(selectedModel, 'support_efforts')}`}</span>}
                      </span>
                      {unknownEfforts && !effortsEditing ? (
                        <div className="pm-effort-unknown">
                          <span className="pm-tag unknown">未确认</span>
                          <button type="button" className="btn ghost small" onClick={startEffortEditing} disabled={locked}>
                            手动指定
                          </button>
                        </div>
                      ) : (
                        <>
                          <div className="pm-chips">
                            {EFFORT_CHOICES.map(value => (
                              <button
                                key={value}
                                type="button"
                                className={`pm-chip${supportEfforts.includes(value) ? ' is-on' : ''}`}
                                onClick={() => toggleEffort(value)}
                                disabled={locked}
                                aria-pressed={supportEfforts.includes(value)}
                              >
                                {effortLabel(value)}
                              </button>
                            ))}
                            {supportEfforts.filter(value => !EFFORT_CHOICES.includes(value)).map(value => (
                              <button
                                key={value}
                                type="button"
                                className="pm-chip is-on"
                                onClick={() => toggleEffort(value)}
                                disabled={locked}
                                aria-pressed="true"
                              >
                                {effortLabel(value)}
                              </button>
                            ))}
                          </div>
                          <div className="pm-inline-add">
                            <input
                              className="text-input"
                              type="text"
                              value={customEffort}
                              onChange={event => setCustomEffort(event.target.value)}
                              onKeyDown={event => { if (event.key === 'Enter') addCustomEffort(); }}
                              placeholder="添加自定义等级，例如 high"
                              aria-label="添加自定义思考等级"
                              disabled={locked}
                            />
                            <button type="button" className="btn small" onClick={addCustomEffort} disabled={locked || !customEffort.trim()}>
                              <Icon name="plus" size={14} />
                              <span>添加</span>
                            </button>
                          </div>
                          <span className="pm-hint">没有任何选中项时表示这个模型不提供可选等级。</span>
                        </>
                      )}
                    </div>

                    <div className="pm-field">
                      <span className="pm-label">助手使用的思考设置</span>
                      {!!unavailableEfforts.length && <span className="pm-hint">服务声明的 {unavailableEfforts.join('、')} 等级，当前 Kimi 无法使用。</span>}
                      <div className="pm-grid2">
                        <span className="pm-select">
                          <select
                            value={thinking}
                            onChange={event => changeThinking(event.target.value)}
                            disabled={locked || draft.thinking_supported === false}
                            aria-label="思考模式"
                          >
                            <option value="default">跟随默认</option>
                            <option value="on">开启思考</option>
                            <option value="off">关闭思考</option>
                          </select>
                          <Icon name="chevronDown" size={14} className="pm-caret" />
                        </span>
                        <span className="pm-select">
                          <select
                            value={effort}
                            onChange={event => changeEffort(event.target.value)}
                            disabled={locked || thinking === 'off' || draft.thinking_supported === false}
                            aria-label="思考等级"
                          >
                            <option value="default">跟随模型默认</option>
                            {supportEfforts.map(value => (
                              <option key={value} value={value}>{effortLabel(value)}</option>
                            ))}
                          </select>
                          <Icon name="chevronDown" size={14} className="pm-caret" />
                        </span>
                      </div>
                      {draft.thinking_supported === false && <span className="pm-hint">这个模型不支持思考设置。</span>}
                      {draft.thinking_supported !== false && unknownEfforts && (
                        <span className="pm-hint">等级未确认，只能跟随模型默认。</span>
                      )}
                    </div>

                    {test && (
                      <p className={`pm-test${test.passed ? ' ok' : ' bad'}`} role="status">
                        <Icon name={test.passed ? 'check' : 'alert'} size={14} />
                        <span>
                          {test.passed ? '请求成功' : '请求未通过'}
                          {test.latency_ms != null ? ` · ${test.latency_ms} ms` : ''}
                        </span>
                        {test.tool_call_verified === true && <span className="pm-tag ok">工具调用已验证</span>}
                        {test.tool_call_verified === false && <span className="pm-tag unknown">工具能力未确认</span>}
                        {test.message && <em title={test.message}>{test.message}</em>}
                      </p>
                    )}

                    <div className="pm-actions">
                      {!!selectedModel.studio_overrides?.length && <button type="button" className="btn ghost small" onClick={resetMetadata}
                        disabled={locked} title="清除角色工坊中的手动参数覆盖，重新使用自动匹配的规格">恢复自动</button>}
                      <button
                        type="button"
                        className="btn small"
                        onClick={probeModel}
                        disabled={locked || !nativeId}
                        title="发一次最小工具调用，确认这个模型能驱动角色工坊"
                      >
                        <Icon name="terminal" size={15} />
                        <span>测试工具调用</span>
                      </button>
                      <button type="button" className="btn small" onClick={() => saveModelParams()} disabled={locked}>
                        <Icon name="save" size={15} />
                        <span>保存参数</span>
                      </button>
                      <button
                        type="button"
                        className="btn primary small"
                        onClick={() => selectModel(thinking, effort, true)}
                        disabled={locked || !nativeId}
                        title="让 Kimi 助手使用这个模型"
                      >
                        <Icon name="check" size={15} />
                        <span>{isSelectedModel ? '重新选用' : '选用此模型'}</span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </section>
        </div>

        <footer className="pm-foot">
          <span className="pm-foot-note">{selectionSummary}</span>
          <button type="button" className="btn ghost small" onClick={() => !busy && onClose?.()} disabled={busy}>
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}
