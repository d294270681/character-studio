const STAGES = { original: '原始图', style: '风格化', video: '视频', sprites: '精灵图', export: '导出' };
const redact = value => String(value ?? '').replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]')
  .replace(/((?:api[_-]?key|access[_-]?token|authorization|password|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[已隐藏]');

export function jobEntries(job) {
  const base = { source: 'generation', stage: STAGES[job.stage] || job.stage, job_id: job.id,
    project_path: job.project_path };
  const start = { ...base, id: `job-${job.id}-start`, timestamp: job.created_at, level: 'info',
    message: `启动${base.stage}任务 · ${job.id}`, detail: job.parameters || { directory: job.directory, source: job.source } };
  const events = (job.events || []).map((packet, index) => {
    const event = packet.event;
    const labels = { submitted: `生成请求已提交 · ${packet.prompt_id || ''}`, node: `执行节点 · ${packet.node || packet.class_type || ''}`,
      asset: `候选已生成 · ${packet.record?.path?.split(/[\\/]/).at(-1) || ''}`, result: '生成器已返回结果',
      error: '生成失败', cancelled: '生成已停止' };
    const message = redact(packet.message || labels[event] || `生成事件 · ${event || '状态'}`);
    // New service events carry monotonic sequence numbers. Legacy events use
    // their content as identity so a rolling history cannot duplicate rows.
    const identity = packet.sequence ?? JSON.stringify(packet);
    const { event: _event, timestamp, sequence: _sequence, ...detail } = packet;
    return { ...base, id: `job-${job.id}-${identity}`, timestamp: timestamp || job.created_at,
      order: packet.sequence ?? index + 1, message, detail,
      level: event === 'error' ? 'error' : ['asset', 'result'].includes(event) ? 'success' : event === 'cancelled' ? 'warn' : 'info' };
  });
  const terminal = ['complete', 'error', 'cancelled', 'interrupted'].includes(job.status)
    ? [{ ...base, id: `job-${job.id}-finish-${job.status}`, timestamp: job.finished_at || job.created_at,
      level: job.status === 'complete' ? 'success' : job.status === 'error' ? 'error' : 'warn',
      message: `${base.stage} · ${redact(job.message || job.status)}`, detail: { exit_code: job.exit_code, assets: job.assets?.length || 0,
        directory: job.directory, error: job.error } }] : [];
  return [start, ...events, ...terminal];
}

export function mergeEntries(previous, incoming, limit = 1200) {
  const byId = new Map(previous.map(entry => [entry.id, entry]));
  for (const entry of incoming) if (entry?.id && entry.message) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => {
    const at = Date.parse(a.timestamp) || 0, bt = Date.parse(b.timestamp) || 0;
    return at - bt || (a.order || 0) - (b.order || 0);
  }).slice(-limit);
}

export function filterEntries(entries, source = 'all', query = '', projectPath = '') {
  const text = query.trim().toLowerCase();
  return entries.filter(entry => (!projectPath || !entry.project_path || entry.project_path === projectPath)
    && (source === 'all' || (source === 'error' ? entry.level === 'error' : entry.source === source))
    && (!text || `${entry.message} ${entry.stage || ''} ${JSON.stringify(entry.detail || '')}`.toLowerCase().includes(text)));
}

export function formatEntries(entries) {
  return entries.map(entry => `[${entry.timestamp || ''}] [${entry.source}] [${entry.level || 'info'}] ${entry.message}`
    + (entry.detail ? '\n' + JSON.stringify(entry.detail, null, 2) : '')).join('\n\n');
}
