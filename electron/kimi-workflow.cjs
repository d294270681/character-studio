const STAGES = Object.freeze(['original', 'style', 'video', 'sprites']);
const LABELS = Object.freeze({ original: '1 人物原始图', style: '2 原始图风格化', video: '3 动作视频', sprites: '4 精灵图' });

function executionStages(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.some(stage => !STAGES.includes(stage)))
    throw new Error('请选择要执行的步骤：单独第 1、2、3、4 步，或从第 1 步连续执行。');
  const single = raw.length === 1;
  const prefix = raw.length >= 2 && raw.length <= 4 && raw.every((stage, index) => stage === STAGES[index]);
  if (!single && !prefix) throw new Error('执行范围只支持单步，或 1–2、1–2–3、1–2–3–4。');
  return [...raw];
}

function executionInstructions(stages, workflow) {
  const labels = stages.map(stage => LABELS[stage]).join(' → ');
  return [
    `本次用户在界面选择的执行范围：${labels}。工作流 ID：${workflow.id}。`,
    `按顺序执行 ${stages.join(' → ')}，所有步骤都要完成。界面的执行范围具有约束力；对话历史只用于人物特征等背景，不得扩展或缩减范围。`,
    '这是执行任务：为每一步编写完整人物、风格或动作提示词，并用 studio_set_parameters 写入实际表单，再调用 studio_generate。精灵步骤也要用 studio_set_parameters 填写转换参数。只在聊天里给出建议不算完成。',
    '提交每个任务后，通过 studio_job_status（wait_seconds=20）等待真实完成；生成器还在运行时不可结束会话。任务失败或取消就停止后续步骤，报告实际错误。',
    '加载权重、排队或采样耗时较长是正常状态，按工具返回的真实执行状态等待，不因几分钟没有新候选就判定失败。候选不合适时可重新填写并生成最近完成的步骤；下一步开始生成后不能退回。',
    stages.length > 1
      ? '用户已经授权你为连续流程选用中间结果：上一步完成后，根据结果元数据并在支持时用 studio_inspect_asset 检查，调用 studio_select_asset 选定该步新生成的候选，再执行下一步。保留所有候选，不再次询问是否继续。最后一步的候选留给用户确认。'
      : '单步执行只生成本步骤的新候选，保留已有结果；默认将新候选留给用户确认，不启动其它步骤。',
    '使用当前项目。禁止新建、切换项目或修改其它步骤。每一步使用前一步实际选定的结果；不得拿历史任务冒充本次生成完成。',
    '结尾简洁报告完成的步骤与实际产物。如果模型不支持图像输入，只依据工具元数据说明结果，不声称做过视觉检查。',
  ].join('\n');
}

module.exports = { STAGES, LABELS, executionStages, executionInstructions };
