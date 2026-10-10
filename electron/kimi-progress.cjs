const ACTIVE = new Set(['starting', 'preparing', 'queued', 'loading', 'running', 'cancelling']);
const PHASE_LABELS = Object.freeze({
  preparing: '正在准备本地生成服务', queued: '生成任务正在排队',
  loading: '正在加载模型权重并准备推理', encoding: '正在编码提示词或参考图',
  generating: '本地生成任务正在运行', decoding: '正在解码并保存结果',
  processing: '正在处理视频或转换精灵图', cancelling: '正在取消本地任务，等待确认',
});

// Resolve ownership from the authoritative execution snapshot, job records,
// and workflow job IDs. A missing list entry is not proof that GPU work ended.
function executionState(state, workflowId) {
  if (!workflowId) return { kind: 'idle' };
  if (!state || !Array.isArray(state.jobs)) return { kind: 'unknown' };
  const workflow = state.assistant;
  const ids = new Set(workflow?.id === workflowId
    ? (workflow.steps || []).flatMap(step => step.job_ids || []) : []);
  const owned = job => job?.workflow_id === workflowId ||
    (job && !job.workflow_id && ids.has(job.id));
  const execution = state.execution;
  if (execution?.workflow_id === workflowId && ACTIVE.has(execution.status))
    return { kind: 'active', job: { id: execution.job_id, ...execution }, detail: execution };
  const job = state.jobs.find(item => owned(item) && ACTIVE.has(item.status));
  if (job) return { kind: 'active', job, detail: job.execution || {} };
  if (state.active_job && !state.jobs.some(item => item.id === state.active_job)) {
    if (execution?.job_id !== state.active_job || !execution.workflow_id)
      return { kind: 'unknown', jobId: state.active_job };
  }
  if (!Object.hasOwn(state, 'execution') && workflow?.id === workflowId &&
      (workflow.steps || []).some(step => step.status === 'running' &&
        (step.job_ids || []).some(id => !state.jobs.some(item => item.id === id))))
    return { kind: 'unknown' };
  return { kind: 'idle' };
}

// Five minutes without a step change is a warning, not a deadline. Only
// silence plus confirmed absence of local execution ends the assistant.
class KimiProgress {
  constructor(now = Date.now(), { idleMs = 120000, progressMs = 300000 } = {}) {
    this.started = this.lastActivity = this.lastProgress = now;
    this.idleMs = idleMs;
    this.progressMs = progressMs;
    this.phase = 'connecting';
    this.fingerprint = null;
    this.thoughtChunks = 0;
    this.wasExecuting = false;
  }
  activity(update, now = Date.now()) {
    const kind = update?.sessionUpdate;
    if (!['agent_thought_chunk', 'agent_message_chunk', 'tool_call', 'tool_call_update'].includes(kind)) return;
    this.lastActivity = now;
    if (kind === 'agent_thought_chunk') { this.phase = 'thinking'; this.thoughtChunks++; }
    else if (kind === 'agent_message_chunk') this.phase = 'responding';
    else this.phase = update.status === 'completed' || update.status === 'failed' ? 'waiting' : 'tool';
  }
  snapshot(state, workflowId, now = Date.now()) {
    const workflow = state?.assistant;
    const execution = executionState(state, workflowId);
    const ownsWorkflow = !!workflowId && workflow?.id === workflowId;
    const fingerprint = ownsWorkflow ? JSON.stringify([workflow.current_stage, workflow.steps,
      (workflow.stages || []).map(stage => state.settings?.[stage])]) : null;
    if (fingerprint !== this.fingerprint || execution.kind !== 'idle' || this.wasExecuting) this.lastProgress = now;
    this.fingerprint = fingerprint;
    // A completed job or recovered service gets a fresh reply window, even
    // when the last successful poll was a long time ago.
    if (execution.kind !== 'idle' || this.wasExecuting) this.lastActivity = now;
    this.wasExecuting = execution.kind !== 'idle';
    const idleSeconds = Math.floor((now - this.lastActivity) / 1000);
    const elapsedSeconds = Math.floor((now - this.started) / 1000);
    const noProgressSeconds = Math.floor((now - this.lastProgress) / 1000);
    let phase = idleSeconds >= 30 ? 'waiting' : this.phase;
    const labels = { connecting: '正在连接 Kimi', thinking: '模型正在思考', responding: '正在接收模型回复',
      tool: '正在调用工坊工具', waiting: `等待模型回复（${idleSeconds} 秒）`, ...PHASE_LABELS };
    let label = labels[phase];
    if (execution.kind === 'active') {
      const { job, detail } = execution;
      phase = job.status === 'cancelling' ? 'cancelling'
        : Object.hasOwn(PHASE_LABELS, detail.phase) ? detail.phase
        : job.status === 'starting' || job.status === 'preparing' ? 'preparing'
        : job.status === 'queued' || job.status === 'loading' ? job.status
        : job.stage === 'sprites' ? 'processing' : 'generating';
      label = job.status === 'cancelling' ? PHASE_LABELS.cancelling
        : detail.label || job.message || labels[phase];
    } else if (execution.kind === 'unknown') {
      phase = 'checking_execution';
      label = '正在核实本地任务状态，继续等待';
    }
    const error = execution.kind === 'idle' && now - this.lastActivity >= this.idleMs
      ? `Kimi 连续 ${idleSeconds} 秒没有返回消息，已确认当前没有本工作流的生成任务运行。已结束等待，请重试；已完成的候选保留。` : null;
    const warning = !error && execution.kind === 'idle' && ownsWorkflow && now - this.lastProgress >= this.progressMs
      ? `当前步骤已 ${Math.floor(noProgressSeconds / 60)} 分钟未变化，助手仍有响应，继续等待；可手动停止。` : null;
    return { phase, label, elapsed_seconds: elapsedSeconds, idle_seconds: idleSeconds,
      no_progress_seconds: noProgressSeconds, thought_chunks: this.thoughtChunks,
      execution_kind: execution.kind, job_id: execution.job?.id || execution.jobId || null,
      prompt_id: execution.detail?.prompt_id || null, node_type: execution.detail?.node_type || null,
      warning, error };
  }
}
module.exports = { KimiProgress, executionState };
