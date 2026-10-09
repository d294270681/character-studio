export const STAGE_KEYS = ['original', 'style', 'video', 'sprites'];

// The seven execution choices offered in the Kimi drawer. Values are the exact
// strings the runner and the service exchange; labels stay Chinese and short.
export const WORKFLOW_CHOICES = [
  { value: 'original', label: '第 1 步 · 人物原始图' },
  { value: 'style', label: '第 2 步 · 人物风格化' },
  { value: 'video', label: '第 3 步 · 生成视频' },
  { value: 'sprites', label: '第 4 步 · 转换精灵图' },
  { value: 'original,style', label: '第 1-2 步 · 原始图 + 风格化' },
  { value: 'original,style,video', label: '第 1-2-3 步 · 原始图 + 风格化 + 视频' },
  { value: 'original,style,video,sprites', label: '第 1-2-3-4 步 · 完整流程' },
];

export function stagesFromValue(value) {
  if (Array.isArray(value)) {
    return STAGE_KEYS.filter(stage => value.includes(stage));
  }
  const parts = String(value || '').split(',').map(part => part.trim()).filter(Boolean);
  return STAGE_KEYS.filter(stage => parts.includes(stage));
}

export function valueFromStages(stages) {
  return stagesFromValue(stages).join(',');
}

export function isChain(value) {
  return stagesFromValue(value).length > 1;
}

export function choiceLabel(value) {
  const found = WORKFLOW_CHOICES.find(choice => choice.value === value);
  if (found) return found.label;
  const stages = stagesFromValue(value);
  return stages.length ? stages.join(' + ') : '未选择步骤';
}

export function stepStatusLabel(status) {
  return {
    pending: '待执行',
    preparing: '准备中',
    running: '处理中',
    complete: '完成',
    error: '失败',
    cancelled: '已取消',
  }[status] || '待执行';
}

export function stepStatusKind(status) {
  if (status === 'complete') return 'ok';
  if (status === 'preparing' || status === 'running') return 'busy';
  if (status === 'error') return 'bad';
  if (status === 'cancelled') return 'muted';
  return 'pending';
}

export function assistantStatusLabel(status) {
  return {
    running: '进行中',
    complete: '已完成',
    error: '失败',
    cancelled: '已取消',
    interrupted: '已中断',
  }[status] || '';
}

export function assistantStatusKind(status) {
  if (status === 'running') return 'busy';
  if (status === 'complete') return 'ok';
  if (status === 'error') return 'bad';
  if (status === 'cancelled' || status === 'interrupted') return 'muted';
  return 'pending';
}

// state.assistant is optional until the service lands; normalize to a stable
// shape and treat anything unusable as "no workflow".
export function normalizeAssistant(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const steps = Array.isArray(raw.steps) ? raw.steps.map(step => ({
    stage: String(step?.stage || ''),
    status: String(step?.status || 'pending'),
    jobIds: Array.isArray(step?.job_ids) ? step.job_ids.filter(Boolean) : [],
    assets: Array.isArray(step?.assets) ? step.assets.filter(Boolean) : [],
    selectedAssetId: step?.selected_asset_id || '',
    message: step?.message || '',
  })).filter(step => STAGE_KEYS.includes(step.stage)) : [];
  const stages = Array.isArray(raw.stages) && raw.stages.length
    ? stagesFromValue(raw.stages)
    : steps.map(step => step.stage);
  return {
    id: raw.id || '',
    projectPath: raw.project_path || '',
    stages,
    status: String(raw.status || ''),
    currentStage: raw.current_stage || '',
    message: raw.message || '',
    steps,
  };
}

export function assistantActive(assistant) {
  return !!assistant && assistant.status === 'running';
}

export function stepFor(assistant, stage) {
  if (!assistant) return null;
  return assistant.steps.find(step => step.stage === stage) || null;
}

export function stepMessage(assistant, jobs) {
  if (!assistant) return '';
  const step = stepFor(assistant, assistant.currentStage);
  if (!step) return assistant.message || '';
  const job = [...(jobs || [])].reverse().find(item => step.jobIds.includes(item.id));
  return job?.message || step.message || assistant.message || '';
}

export function stepProgress(assistant, jobs) {
  if (!assistant) return null;
  const step = stepFor(assistant, assistant.currentStage);
  if (!step) return null;
  const job = [...(jobs || [])].reverse().find(item => step.jobIds.includes(item.id));
  return job?.progress || null;
}
