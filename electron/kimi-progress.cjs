// Track model activity separately from actual workflow progress. A thought
// stream is alive, but must not keep a generation workflow locked forever.
class KimiProgress {
  constructor(now = Date.now(), { idleMs = 120000, progressMs = 300000 } = {}) {
    this.started = this.lastActivity = this.lastProgress = now;
    this.idleMs = idleMs;
    this.progressMs = progressMs;
    this.phase = 'connecting';
    this.fingerprint = null;
    this.thoughtChunks = 0;
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
    const jobs = state?.jobs || [];
    const active = jobs.find(job => job.id === state?.active_job &&
      (!workflowId || job.workflow_id === workflowId) && ['starting', 'running', 'cancelling'].includes(job.status));
    const ownsWorkflow = workflowId && workflow?.id === workflowId;
    const fingerprint = ownsWorkflow ? JSON.stringify([workflow.current_stage, workflow.steps,
      (workflow.stages || []).map(stage => state.settings?.[stage])]) : null;
    if (fingerprint !== this.fingerprint || active) this.lastProgress = now;
    this.fingerprint = fingerprint;
    // Generation can legitimately take much longer than a model response.
    // Never interrupt an owned GPU/conversion job because the model is quiet.
    if (active) this.lastActivity = now;
    const idleSeconds = Math.floor((now - this.lastActivity) / 1000);
    const elapsedSeconds = Math.floor((now - this.started) / 1000);
    let error = null;
    if (!active && now - this.lastActivity >= this.idleMs)
      error = `Kimi 连续 ${idleSeconds} 秒没有返回消息，当前没有生成任务运行。已结束等待，请重试；已完成的候选保留。`;
    else if (!active && ownsWorkflow && now - this.lastProgress >= this.progressMs)
      error = `Kimi 超过 ${Math.floor(this.progressMs / 60000)} 分钟没有推进当前步骤，当前没有生成任务运行。已结束等待，请重试；已完成的候选保留。`;
    const phase = active ? 'generating' : idleSeconds >= 30 ? 'waiting' : this.phase;
    const labels = { connecting: '正在连接 Kimi', thinking: '模型正在思考', responding: '正在接收模型回复',
      tool: '正在调用工坊工具', waiting: `等待模型回复（${idleSeconds} 秒）`, generating: '本地生成任务正在运行' };
    return { phase, label: labels[phase], elapsed_seconds: elapsedSeconds, idle_seconds: idleSeconds,
      thought_chunks: this.thoughtChunks, error };
  }
}
module.exports = { KimiProgress };
