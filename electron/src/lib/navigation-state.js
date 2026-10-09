function belongsToProject(ownerPath, projectPath) {
  const normalize = value => String(value).replace(/\\/g, '/').toLowerCase();
  return !ownerPath || !projectPath || normalize(ownerPath) === normalize(projectPath);
}

const state = (status, kind, label, title, source) => ({ status, kind, label, title, source });

// Navigation describes the whole project. The workflow card separately keeps
// the history and outcome of the latest Kimi task.
export function navigationState(stage, { project, activeJob, assistant } = {}) {
  if (activeJob?.stage === stage && belongsToProject(activeJob.project_path, project?.path)) {
    if (activeJob.status === 'starting') {
      return state('starting', 'busy', '准备中', activeJob.message || '正在启动本步任务。', 'job');
    }
    if (activeJob.status === 'running') {
      return state('running', 'busy', stage === 'sprites' ? '转换中' : '生成中', activeJob.message || '本步任务正在执行。', 'job');
    }
    if (activeJob.status === 'cancelling') {
      return state('cancelling', 'busy', '停止中', '正在等待当前任务确认停止。', 'job');
    }
  }

  const step = belongsToProject(assistant?.projectPath, project?.path)
    ? assistant?.steps?.find(item => item.stage === stage) : null;
  if (assistant?.status === 'running' && step) {
    if (step.status === 'pending') {
      return state('pending', 'pending', '待执行', 'Kimi 将在前面的步骤完成后执行本步。', 'workflow');
    }
    if (step.status === 'preparing' || step.status === 'running') {
      return state(step.status, 'busy', step.status === 'preparing' ? '准备中' : '处理中', step.message || 'Kimi 正在处理本步。', 'workflow');
    }
  }

  const assets = Array.isArray(project?.assets?.[stage]) ? project.assets[stage] : [];
  const selected = assets.find(item => item.id === project?.selected?.[stage]);
  if (selected) {
    return state('selected', 'ok', '已选用', `已选用本步结果，共有 ${assets.length} 个候选。`, 'project');
  }
  if (assets.length) {
    return state('candidates', 'pending', '待选用', `已有 ${assets.length} 个候选。查看后点击“选用”，即可作为后续步骤的输入；上游变更后需重新确认。`, 'project');
  }
  if (step?.status === 'error') {
    return state('error', 'bad', '失败', step.message || '最近一次 Kimi 任务在本步失败，还没有结果。', 'workflow');
  }
  if (step?.status === 'cancelled') {
    return state('cancelled', 'muted', '已取消', step.message || '最近一次 Kimi 任务取消了本步，还没有结果。', 'workflow');
  }
  return state('empty', 'muted', '未生成', '还没有生成或导入本步结果。', 'project');
}
