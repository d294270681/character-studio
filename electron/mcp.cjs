const readline = require('node:readline');
const { StudioBridge, sleep } = require('./bridge.cjs');

const stageSchema = { type: 'string', enum: ['original', 'style', 'video', 'sprites'] };
const parametersSchema = {
  type: 'object', description: '当前阶段的参数。quality: 0=4步,1=8步,2=24步,3=40步,4=50步。seed 使用字符串避免大整数丢失精度。',
  properties: {
    prompt: { type: 'string' }, extra: { type: 'string' }, width: { type: 'integer' }, height: { type: 'integer' },
    quality: { type: 'integer', minimum: 0, maximum: 4 }, count: { type: 'integer', minimum: 1, maximum: 4 },
    seed: { type: ['string', 'null'] }, style: { type: 'string' }, view: { type: 'string' }, white: { type: 'boolean' },
    motion: { type: 'string' }, length: { type: 'integer' }, frames: { type: 'integer' }, columns: { type: 'integer' },
    cell_size: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 }, pixel_grid: { type: 'integer' },
    clean_background: { type: 'boolean', description: 'Video: clean white background after H3 generation and retain the original video.' },
    remove_shadows: { type: 'boolean', description: 'Sprites: suppress neutral grey shadows using the opening frame as reference.' },
    sampling: { type: 'string', enum: ['uniform', 'source'], description: 'uniform uses frames; source retains every frame of the chosen interval, up to 256.' },
    alignment: { type: 'string', enum: ['source', 'feet'], description: 'source preserves original movement; feet aligns each frame to a stable foot position.' },
    transparent: { type: 'boolean' }, auto_cycle: { type: 'boolean' }, start_seconds: { type: 'number' },
    end_seconds: { type: 'number' }, animation_name: { type: 'string' },
  }, additionalProperties: false,
};
const define = (name, description, properties = {}, required = [], readOnly = false) => ({
  name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false },
});
const tools = [
  define('studio_get_state', '读取当前角色项目、已选结果、可用模板和参数。每次操作先读取；不会生成或改变项目。', {}, [], true),
  define('studio_list_projects', '列出角色项目。', {}, [], true),
  define('studio_open_project', '按用户指令打开已有 project.json。生成过程中禁止切换。', { path: { type: 'string' } }, ['path']),
  define('studio_create_project', '创建独立角色项目并打开。应在用户要求新角色时使用。', { name: { type: 'string' } }, ['name']),
  define('studio_set_parameters', '把当前执行步骤的完整提示词和参数写入桌面表单并立即显示；生成前先填写它。', { stage: stageSchema, values: parametersSchema }, ['stage', 'values']),
  define('studio_prepare_generation', '预览完整生成请求并检查输入和模型；不会启动。参考图只使用用户已经选定的结果。', { stage: stageSchema, parameters: parametersSchema }, ['stage'], true),
  define('studio_generate', '启动当前工作流的一个步骤，桌面会显示按钮状态、进度和新候选。返回 job_id 后必须用 studio_job_status 等待真实完成。连续流程需要先选用上一步新候选。', { stage: stageSchema, parameters: parametersSchema }, ['stage']),
  define('studio_job_status', '读取实际任务状态。wait_seconds 最多 20 秒，仅在任务未结束时等待。不要把已提交当作已完成。', { job_id: { type: 'string' }, wait_seconds: { type: 'integer', minimum: 0, maximum: 20 } }, ['job_id'], true),
  define('studio_inspect_asset', '返回结果图片与元数据供视觉检查。视频默认返回多帧接触表；view=poster只看封面。抽样不能证明整段动作质量。精灵图也可看contact_sheet。', { stage: stageSchema, asset_id: { type: 'string' }, view: { type: 'string', enum: ['default', 'poster', 'contact_sheet'] } }, ['stage'], true),
  define('studio_select_asset', '选用候选作为下一步参考。用户选择连续执行已授权选用中间新候选；最后一步默认留待用户确认。更换上游只清除后续选定项，历史候选保留。', { stage: stageSchema, asset_id: { type: 'string' } }, ['stage', 'asset_id']),
  define('studio_import_asset', '按用户提供的绝对路径导入参考图或视频并选定。', { stage: { type: 'string', enum: ['original', 'style', 'video'] }, path: { type: 'string' } }, ['stage', 'path']),
  define('studio_cancel_job', '只取消指定的当前任务；已完成的图片保留。', { job_id: { type: 'string' } }, ['job_id']),
  define('studio_export_godot', '将指定精灵图导出成 Godot 资源和预览场景。', { asset_id: { type: 'string' }, preview: { type: 'boolean', default: false } }, []),
];
const WORKFLOW_TOOLS = new Set(['studio_get_state', 'studio_set_parameters', 'studio_prepare_generation',
  'studio_generate', 'studio_job_status', 'studio_inspect_asset', 'studio_select_asset', 'studio_cancel_job']);

function compactJob(job) {
  return { job_id: job.id, stage: job.stage, status: job.status, message: job.message, progress: job.progress,
    assets: job.assets, result: job.result, error: job.error, directory: job.directory, workflow_id: job.workflow_id };
}
function compactState(state) {
  const { project, ...rest } = state;
  delete rest.jobs;
  return { ...rest, project: { name: project.name, path: project.path, selected: project.selected,
    assets: Object.fromEntries(Object.entries(project.assets).map(([stage, assets]) => [stage, assets.slice(-16).map(
      ({ id, path, model, seed, steps, style, motion, created_at, frames }) => ({ id, path, model, seed, steps, style, motion, created_at, frames }))])) },
    jobs: state.jobs.slice(0, 5).map(compactJob) };
}

async function callTool(bridge, name, args, workflowId = process.env.CHARACTER_STUDIO_WORKFLOW_ID || '') {
  if (workflowId && !WORKFLOW_TOOLS.has(name)) throw new Error('当前执行工作流不支持这个操作：' + name);
  const api = (route, body) => bridge.request('POST', route, workflowId ? { ...body, workflow_id: workflowId } : body);
  switch (name) {
    case 'studio_get_state': return compactState(await bridge.request('GET', '/api/state'));
    case 'studio_list_projects': return bridge.request('GET', '/api/projects');
    case 'studio_open_project': return compactState(await api('/api/projects/open', args));
    case 'studio_create_project': return compactState(await api('/api/projects', args));
    case 'studio_set_parameters': return api('/api/settings', args);
    case 'studio_prepare_generation': return api('/api/prepare', args);
    case 'studio_generate': return compactJob(await api('/api/jobs', { ...args, source: 'kimi' }));
    case 'studio_cancel_job': return compactJob(await api(`/api/jobs/${encodeURIComponent(args.job_id)}/cancel`, {}));
    case 'studio_import_asset': return api('/api/assets/import', args);
    case 'studio_select_asset': return api('/api/assets/select', args);
    case 'studio_export_godot': return compactJob(await api('/api/jobs', { stage: 'export', parameters: args, source: 'kimi' }));
    case 'studio_inspect_asset': {
      const result = await api('/api/assets/inspect', args);
      const { image_base64, mime_type, ...info } = result;
      return { content: [{ type: 'text', text: JSON.stringify(info) }, { type: 'image', data: image_base64, mimeType: mime_type }] };
    }
    case 'studio_job_status': {
      const deadline = Date.now() + Math.max(0, Math.min(20, Number(args.wait_seconds) || 0)) * 1000;
      let job;
      do {
        job = await bridge.request('GET', `/api/jobs/${encodeURIComponent(args.job_id)}`);
        if (!['starting', 'running', 'cancelling'].includes(job.status) || Date.now() >= deadline) break;
        await sleep(Math.min(1000, deadline - Date.now()));
      } while (true);
      return compactJob(job);
    }
    default: throw new Error('未知工具：' + name);
  }
}

async function main() {
  const bridge = new StudioBridge();
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  // Once the client closes its pipe there is no session left to serve. Stop the
  // helper even if an HTTP connection or a pending status poll is still alive.
  input.once('close', () => setImmediate(() => process.exit(0)));
  const send = message => process.stdout.write(JSON.stringify(message) + '\n');
  input.on('line', async line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (!Object.hasOwn(message, 'id')) return;
    try {
      let result;
      if (message.method === 'initialize') result = { protocolVersion: message.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} }, serverInfo: { name: 'character-studio', version: require('./package.json').version },
        instructions: '依照 state.assistant.stages 按序执行。先把完整提示词和参数写入实际表单，再生成、等待真实完成。连续流程可选用中间候选继续，最后候选留给用户；失败就停止。' };
      else if (message.method === 'ping') result = {};
      else if (message.method === 'tools/list') result = { tools: process.env.CHARACTER_STUDIO_WORKFLOW_ID ? tools.filter(tool => WORKFLOW_TOOLS.has(tool.name)) : tools };
      else if (message.method === 'tools/call') {
        try {
          const data = await callTool(bridge, message.params.name, message.params.arguments || {});
          result = data?.content ? data : { content: [{ type: 'text', text: JSON.stringify(data) }] };
        } catch (error) { result = { isError: true, content: [{ type: 'text', text: error.message }] }; }
      } else { send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }); return; }
      send({ jsonrpc: '2.0', id: message.id, result });
    } catch (error) { send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } }); }
  });
}

if (require.main === module) main().catch(error => { process.stderr.write(error.message + '\n'); process.exit(1); });
module.exports = { tools, callTool, compactState, compactJob, WORKFLOW_TOOLS };
