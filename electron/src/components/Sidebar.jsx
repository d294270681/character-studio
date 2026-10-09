import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { STAGES, STAGE_LABELS } from '../lib/studio.js';
import { navigationState } from '../lib/navigation-state.js';

const STAGE_DESCRIPTIONS = {
  original: '描述与生成',
  style: '画风与构图',
  video: '动作与镜头',
  sprites: '切帧与导出',
};

export default function Sidebar({
  stageIndex, onStage, projectName, onRename, onNew, onOpen, onRelease, onHelp,
  busy, comfyOnline, kimiRunning, kimiInstalled, project, activeJob, assistant,
}) {
  const [renaming, setRenaming] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [draft, setDraft] = useState(projectName || '');

  useEffect(() => { setDraft(projectName || ''); }, [projectName]);

  const commit = () => {
    const name = draft.trim();
    setRenaming(false);
    if (name && name !== projectName) onRename(name);
    else setDraft(projectName || '');
  };

  const create = () => {
    const name = newName.trim() || '新角色';
    setCreating(false);
    setNewName('');
    onNew(name);
  };

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark"><Icon name="sparkle" size={18} /></span>
        <span className="brand-text">
          <strong>角色工坊</strong>
          <em>CHARACTER STUDIO</em>
        </span>
      </div>

      <div className="project-block">
        {creating ? (
          <div className="create-row">
            <input
              className="text-input"
              autoFocus
              value={newName}
              placeholder="新角色名称"
              onChange={event => setNewName(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') create();
                if (event.key === 'Escape') { setCreating(false); setNewName(''); }
              }}
            />
            <button type="button" className="icon-btn" title="创建" onClick={create}>
              <Icon name="check" size={15} />
            </button>
            <button type="button" className="icon-btn" title="取消" onClick={() => { setCreating(false); setNewName(''); }}>
              <Icon name="close" size={15} />
            </button>
          </div>
        ) : renaming ? (
          <input
            className="text-input"
            autoFocus
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={event => {
              if (event.key === 'Enter') commit();
              if (event.key === 'Escape') { setDraft(projectName || ''); setRenaming(false); }
            }}
          />
        ) : (
          <button
            type="button"
            className="project-name"
            data-testid="project-name"
            disabled={busy}
            onClick={() => { if (!busy) setRenaming(true); }}
            title={busy ? '任务进行中，暂时不能重命名' : '点击重命名'}
          >
            <span>{projectName || '未命名角色'}</span>
            <Icon name="wand" size={14} />
          </button>
        )}
      </div>

      <nav className="nav">
        {STAGES.map((stage, index) => {
          const status = navigationState(stage, { project, activeJob, assistant });
          return (
            <button
              key={stage}
              type="button"
              className={`nav-item has-step${index === stageIndex ? ' is-active' : ''}`}
              data-testid={`stage-nav-${stage}`}
              data-stage={stage}
              aria-current={index === stageIndex ? 'step' : undefined}
              onClick={() => onStage(index)}
            >
              <span className="nav-index">{String(index + 1).padStart(2, '0')}</span>
              <span className="nav-copy">
                <span className="nav-label">{STAGE_LABELS[stage]}</span>
                <span className="nav-details">
                  <span className="nav-description" aria-hidden="true">{STAGE_DESCRIPTIONS[stage]}</span>
                  <span className={`nav-state ${status.kind}`} data-testid={`nav-state-${stage}`} data-status={status.status} data-source={status.source} title={status.title}>
                    {status.kind === 'busy' && <span className="wf-spinner tiny" />}
                    {status.label}
                  </span>
                </span>
              </span>
            </button>
          );
        })}
      </nav>

      <div className="sidebar-spacer" />

      <div className="sidebar-actions">
        <button type="button" className="side-btn" onClick={() => setCreating(true)} disabled={busy}>
          <Icon name="plus" size={15} />
          <span>新建角色</span>
        </button>
        <button type="button" className="side-btn" onClick={onOpen} disabled={busy}>
          <Icon name="folderOpen" size={15} />
          <span>打开项目</span>
        </button>
        <button type="button" className="side-btn" onClick={() => setRenaming(true)} disabled={busy}>
          <Icon name="wand" size={15} />
          <span>重命名</span>
        </button>
        <button type="button" className="side-btn" onClick={onRelease} disabled={busy} title="释放已加载的模型显存，下次生成会自动重新加载">
          <Icon name="cpu" size={15} />
          <span>释放显存</span>
        </button>
        <button type="button" className="side-btn" onClick={onHelp}>
          <Icon name="help" size={15} />
          <span>帮助</span>
        </button>
      </div>

      <div className="sidebar-status">
        <span className={`dot${comfyOnline ? ' ok' : ''}`} />
        <span>{comfyOnline ? '生成服务在线' : '生成服务未启动'}</span>
      </div>
      <div className="sidebar-status">
        <span className={`dot${kimiInstalled ? (kimiRunning ? ' busy' : ' ok') : ''}`} />
        <span>{kimiInstalled ? (kimiRunning ? 'Kimi 正在处理任务' : 'Kimi 助手已就绪') : 'Kimi 未安装'}</span>
      </div>
    </aside>
  );
}
