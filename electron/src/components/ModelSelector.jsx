import { useMemo, useState } from 'react';
import Icon from './Icon.jsx';

const EFFORT_ZH = {
  minimal: '最低',
  low: '轻',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
  none: '无',
};

export const DEFAULT_SELECTION = { provider: '', model: '', thinking: 'default', effort: 'default' };

export function normalizeSelection(selection) {
  return {
    provider: selection?.provider || '',
    model: selection?.model || '',
    thinking: selection?.thinking || 'default',
    effort: selection?.effort || 'default',
  };
}

export function effortLabel(id) {
  const zh = EFFORT_ZH[id];
  return zh ? `${zh} (${id})` : String(id);
}

export function resolveEffectiveModel(catalog, selection) {
  const models = catalog?.models || [];
  if (!models.length) return null;
  const chosen = normalizeSelection(selection);
  const id = chosen.provider
    ? (chosen.model || (models.find(item => item.provider === chosen.provider) || {}).id || '')
    : (catalog.default_model || '');
  if (!id) return null;
  return models.find(item => item.id === id) || null;
}

export function modelBlocksTools(catalog, selection) {
  const model = resolveEffectiveModel(catalog, selection);
  return !!model && model.tool_use === false;
}

export default function ModelSelector({
  catalog, error, loading, saving, disabled, selection, onChange, onRefresh, onManage,
}) {
  const [collapsed, setCollapsed] = useState(false);
  const chosen = normalizeSelection(selection);
  const providers = catalog?.providers || [];
  const models = catalog?.models || [];
  const defaultModel = catalog?.default_model || '';
  const model = resolveEffectiveModel(catalog, selection);
  const locked = !!disabled || !!saving;

  const providerModels = useMemo(
    () => models.filter(item => item.provider === chosen.provider),
    [models, chosen.provider],
  );

  const summary = useMemo(() => {
    if (error) return '读取失败';
    if (!catalog) return loading ? '读取中…' : '未读取';
    if (model) {
      const name = model.label || model.model || model.id;
      const alias = model.model && model.model !== name ? ` · ${model.model}` : '';
      return `${name}${alias}${model.id === defaultModel ? (catalog.fixed_model ? '' : '（Kimi 默认）') : ''}`;
    }
    return defaultModel || '跟随 Kimi 默认';
  }, [catalog, defaultModel, error, loading, model]);

  const capabilities = [];
  if (model) {
    if (model.tool_use === true) capabilities.push({ key: 'tool', label: '工具调用', kind: 'ok' });
    else if (model.tool_use === false) capabilities.push({ key: 'tool', label: '无工具调用', kind: 'bad' });
    if (model.image_in) capabilities.push({ key: 'image', label: '看图', kind: 'ok' });
    if (model.video_in) capabilities.push({ key: 'video', label: '视频', kind: 'ok' });
  }

  const thinkingSupported = !model || model.thinking_supported !== false;
  const thinkingLockedOn = !!model && (model.always_thinking === true || model.can_disable_thinking === false);
  const supportedEfforts = model?.support_efforts || [];
  const staleEffort = chosen.effort !== 'default' && !supportedEfforts.includes(chosen.effort);
  const effortChoices = staleEffort ? [...supportedEfforts, chosen.effort] : supportedEfforts;

  const emit = next => { if (!locked) onChange(normalizeSelection(next)); };

  const changeProvider = event => {
    const id = event.target.value;
    if (!id) { emit(DEFAULT_SELECTION); return; }
    const first = models.find(item => item.provider === id);
    emit({ provider: id, model: first ? first.id : '', thinking: 'default', effort: 'default' });
  };
  const changeModel = event => emit({ ...chosen, model: event.target.value, thinking: 'default', effort: 'default' });
  const changeThinking = event => emit({
    ...chosen,
    thinking: event.target.value,
    effort: event.target.value === 'off' ? 'default' : chosen.effort,
  });
  const changeEffort = event => emit({ ...chosen, effort: event.target.value });

  const followLabel = `跟随 Kimi 默认${defaultModel ? `（${defaultModel}）` : ''}`;
  const fixed = catalog?.fixed_model === true;

  return (
    <section className="model-settings" data-testid="kimi-model-settings">
      <div className="ms-head">
        <button
          type="button"
          className="ms-toggle"
          aria-expanded={!collapsed}
          title={collapsed ? '展开模型设置' : '折叠模型设置'}
          onClick={() => setCollapsed(value => !value)}
        >
          <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={15} />
          <span className="ms-title">模型设置</span>
          <span className="ms-current" title={summary}>{summary}</span>
        </button>
        {onManage && <button type="button" className="btn ghost small" onClick={onManage} data-testid="open-model-manager">
          <Icon name="cpu" size={14} /><span>模型管理</span>
        </button>}
        <button
          type="button"
          className="icon-btn"
          title="刷新 Kimi 配置"
          aria-label="刷新 Kimi 配置"
          onClick={onRefresh}
          disabled={loading}
        >
          <Icon name="refresh" size={15} />
        </button>
      </div>

      {!collapsed && (
        <div className="ms-body">
          {error && (
            <p className="ms-error" role="alert">
              <Icon name="alert" size={14} />
              <span>{error}</span>
            </p>
          )}
          {!catalog && !error && <p className="ms-note">正在读取 Kimi 配置…</p>}

          {catalog && (
            <>
              {catalog.notice && <p className="ms-note warn" role="status">{catalog.notice}</p>}
              <label className="ms-row">
                <span className="ms-label">Provider</span>
                <span className="selectfield">
                  <select aria-label="Kimi Provider" value={chosen.provider} disabled={locked} onChange={changeProvider}>
                    {!fixed && <option value="">{followLabel}</option>}
                    {providers.map(item => (
                      <option key={item.id} value={item.id}>
                        {`${item.label || item.id} · ${item.model_count ?? 0} 个模型`}
                      </option>
                    ))}
                  </select>
                  <Icon name="chevronDown" size={14} className="select-caret" />
                </span>
              </label>

              <label className="ms-row">
                <span className="ms-label">模型</span>
                <span className="selectfield">
                  <select
                    aria-label="Kimi 模型"
                    value={chosen.provider ? chosen.model : ''}
                    disabled={locked || !chosen.provider}
                    onChange={changeModel}
                  >
                    {!chosen.provider && <option value="">{followLabel}</option>}
                    {chosen.provider && providerModels.length === 0 && <option value="">该 Provider 没有可用模型</option>}
                    {providerModels.map(item => (
                      <option key={item.id} value={item.id}>
                        {`${item.label || item.model || item.id}${item.id === defaultModel ? '（默认）' : ''}`}
                      </option>
                    ))}
                  </select>
                  <Icon name="chevronDown" size={14} className="select-caret" />
                </span>
              </label>

              {thinkingSupported ? (
                <>
                  <label className="ms-row">
                    <span className="ms-label">思考模式</span>
                    <span className="selectfield">
                      <select aria-label="思考模式" value={chosen.thinking} disabled={locked} onChange={changeThinking}>
                        <option value="default">跟随 Kimi 默认</option>
                        <option value="on">开启思考</option>
                        <option value="off" disabled={thinkingLockedOn}>
                          {thinkingLockedOn ? '关闭思考（该模型不可关闭）' : '关闭思考'}
                        </option>
                      </select>
                      <Icon name="chevronDown" size={14} className="select-caret" />
                    </span>
                  </label>

                  <label className="ms-row">
                    <span className="ms-label">思考等级</span>
                    <span className="selectfield">
                      <select
                        aria-label="思考等级"
                        value={chosen.effort}
                        disabled={locked || chosen.thinking === 'off'}
                        onChange={changeEffort}
                      >
                        <option value="default">跟随模型默认</option>
                        {effortChoices.map(id => <option key={id} value={id}>{effortLabel(id)}</option>)}
                      </select>
                      <Icon name="chevronDown" size={14} className="select-caret" />
                    </span>
                  </label>
                </>
              ) : (
                <p className="ms-note">该模型不支持思考设置，思考模式与等级无需选择。</p>
              )}

              {thinkingSupported && chosen.thinking === 'off' && <p className="ms-note">思考已关闭，等级设置本次不生效。</p>}
              {thinkingSupported && thinkingLockedOn && <p className="ms-note">该模型始终开启思考，无法关闭。</p>}
              {thinkingSupported && !thinkingLockedOn && !!model && supportedEfforts.length === 0 && (
                <p className="ms-note">该模型没有可选思考等级，只能跟随默认。</p>
              )}
              {staleEffort && (
                <p className="ms-note warn">已保存的等级不在当前模型支持范围内，建议改回“跟随模型默认”。</p>
              )}

              {model && capabilities.length > 0 && (
                <div className="ms-caps">
                  {capabilities.map(cap => <span key={cap.key} className={`ms-cap ${cap.kind}`}>{cap.label}</span>)}
                </div>
              )}

              {model && model.tool_use === false && (
                <p className="ms-note warn">
                  <Icon name="alert" size={13} />
                  <span>该模型不支持工具调用，助手无法读取项目或执行生成，请改用支持工具调用的模型。</span>
                </p>
              )}

            </>
          )}
        </div>
      )}
    </section>
  );
}
