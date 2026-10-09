import Icon from './Icon.jsx';

export default function StatusBar({ status, progress, busy, onCancel, logOpen, onToggleLog, comfyOnline }) {
  const maximum = progress?.maximum || 0;
  const value = progress?.value || 0;
  const percent = maximum > 0 ? Math.min(100, Math.round((value / maximum) * 100)) : 0;

  return (
    <footer className="statusbar">
      <div className="statusbar-row">
        <span className={`dot${comfyOnline ? ' ok' : ''}`} />
        <span className="status-text">{status}</span>
        <div className={`progress${busy && maximum === 0 ? ' is-indeterminate' : ''}`}>
          <div className="progress-fill" style={{ width: `${busy && maximum === 0 ? 100 : percent}%` }} />
        </div>
        <span className="progress-text">{busy ? (maximum > 0 ? `${percent}%` : '处理中') : ''}</span>
        <button type="button" className={`chip${logOpen ? ' is-active' : ''}`} onClick={onToggleLog} aria-expanded={logOpen} title="显示执行控制台 · Ctrl+J">
          <Icon name="terminal" size={14} />
          <span>控制台</span>
        </button>
        <button type="button" className="btn ghost small" disabled={!busy} onClick={onCancel}>
          <Icon name="close" size={15} />
          <span>取消任务</span>
        </button>
      </div>
    </footer>
  );
}
