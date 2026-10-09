import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { filterEntries, formatEntries } from '../lib/execution-log.js';

const SOURCES = { kimi: 'KIMI', generation: '生成器', system: '工坊' };
const timeLabel = value => {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? '' : time.toLocaleTimeString('zh-CN', { hour12: false });
};

export default function ExecutionConsole({ entries, projectPath, busy, onClose, onClear, onCopy }) {
  const [source, setSource] = useState('all');
  const [query, setQuery] = useState('');
  const [follow, setFollow] = useState(true);
  const [expanded, setExpanded] = useState(new Set());
  const scroll = useRef(null);
  const filtered = useMemo(() => filterEntries(entries, source, query, projectPath), [entries, source, query, projectPath]);
  const visible = filtered.slice(-400);
  useLayoutEffect(() => {
    if (follow && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [entries, source, query, follow]);
  const toggle = id => setExpanded(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  return <section className="execution-console" aria-label="执行控制台" data-testid="execution-console">
    <div className="console-heading">
      <h2><Icon name="terminal" size={15} />执行控制台</h2>
      <span className={`console-live${busy ? ' is-live' : ''}`}>{busy ? '正在执行' : '执行记录'}</span>
      <span className="console-total">{filtered.length} 条</span>
      <div className="console-actions">
        <button type="button" className={`chip${follow ? ' is-active' : ''}`} aria-pressed={follow} onClick={() => setFollow(value => !value)} title="自动滚动到最新事件">跟随</button>
        <button type="button" className="icon-btn" aria-label="复制控制台记录" title="复制当前筛选的执行记录" disabled={!filtered.length} onClick={() => onCopy(formatEntries(filtered))}><Icon name="copy" size={15} /></button>
        <button type="button" className="chip" onClick={onClear} title="清空控制台显示，保留项目产物和运行日志">清空</button>
        <button type="button" className="icon-btn" aria-label="收起执行控制台" title="收起控制台 · Ctrl+J" onClick={onClose}><Icon name="chevronDown" size={15} /></button>
      </div>
    </div>
    <div className="console-toolbar">
      <div className="console-filters" role="group" aria-label="控制台来源筛选">
        {[['all', '全部'], ['kimi', 'Kimi'], ['generation', '生成'], ['error', '错误']].map(([value, label]) =>
          <button type="button" key={value} aria-pressed={source === value} className={source === value ? 'is-active' : ''} onClick={() => setSource(value)}>{label}</button>)}
      </div>
      <input className="console-search" aria-label="搜索执行记录" placeholder="搜索工具、节点或任务…" value={query} onChange={event => setQuery(event.target.value)} />
    </div>
    <div className="console-scroll" ref={scroll} role="log" aria-live="off" onScroll={event => {
      const node = event.currentTarget;
      if (follow && node.scrollHeight - node.scrollTop - node.clientHeight > 50) setFollow(false);
    }}>
      {filtered.length > visible.length && <div className="console-overflow">显示最近 400 条，复制可获取全部筛选记录。</div>}
      {!visible.length && <div className="console-empty"><Icon name="terminal" size={20} /><div><strong>{entries.length ? '没有匹配的执行记录' : '等待第一条执行记录'}</strong><span>工具调用、参数、采样进度和错误会显示在这里。</span></div></div>}
      {visible.map(entry => <div className={`console-entry ${entry.level || 'info'}`} key={entry.id} data-source={entry.source} data-level={entry.level}>
        <button type="button" className="console-line" aria-expanded={expanded.has(entry.id)} onClick={() => toggle(entry.id)} title="展开执行详情">
          <time dateTime={entry.timestamp}>{timeLabel(entry.timestamp)}</time>
          <span className="console-source">{SOURCES[entry.source] || entry.source}</span>
          <span className="console-message">{entry.stage && <span className="console-stage">{entry.stage}</span>}{entry.message}</span>
          <Icon name={expanded.has(entry.id) ? 'chevronDown' : 'chevronRight'} size={12} />
        </button>
        {expanded.has(entry.id) && <pre className="console-detail">{entry.detail ? JSON.stringify(entry.detail, null, 2) : entry.message}</pre>}
      </div>)}
    </div>
  </section>;
}
