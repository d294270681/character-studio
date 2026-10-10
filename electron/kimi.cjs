// Kimi Code runner for the character studio.
//
// Model, thinking mode, and thinking effort are applied through the CLI's own
// ACP session options, which is the only mechanism that reaches the wire for
// every provider protocol (verified against the real CLI 2.1.1: `thinking`
// becomes `output_config.effort` on Anthropic, `reasoning_effort` on OpenAI,
// and `thinking.effort` on the kimi protocol). Plain CLI flags cannot express
// thinking at all, and KIMI_MODEL_THINKING_EFFORT only affects kimi-protocol
// providers, so runs go through ACP.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appDirectory } = require('./runtime-paths.cjs');
const { spawn } = require('node:child_process');
const {
  kimiHome, kimiConfigPath, runCatalog, readSelection, saveSelection, normalizeSelection,
  resolveSelection, planThinking, buildTerminalLaunch, findProvider, DEFAULT_SELECTION,
} = require('./kimi-config.cjs');
const { executionStages, executionInstructions } = require('./kimi-workflow.cjs');
const { KimiProgress } = require('./kimi-progress.cjs');
const { safeDetail } = require('./execution-console.cjs');

const PROFILE_FILES = { plan: 'kimi-character-planner.md', execute: 'kimi-character-assistant.md' };
const ACP_MODES = { plan: 'plan', execute: 'auto' };
const REQUEST_TIMEOUT_MS = 120000;
const PLANNER_TOOLS = new Set(['studio_get_state', 'studio_list_projects', 'studio_prepare_generation',
  'studio_job_status', 'studio_inspect_asset', 'Read', 'ReadMediaFile']);

function permissionFor(mode, params) {
  const call = params?.toolCall || {};
  const title = String(call.title || '');
  const name = title.match(/^mcp__character_studio__(studio_[a-z]+(?:_[a-z]+)*)$/)?.[1]
    || (/^(Read|ReadMediaFile)$/.test(title) ? title : null);
  const permitted = name && (mode === 'execute' ? name.startsWith('studio_') || PLANNER_TOOLS.has(name) : PLANNER_TOOLS.has(name));
  const option = permitted && (params.options || []).find(item => item.kind === 'allow_once');
  return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } };
}

function kimiExecutable() {
  const candidates = [process.env.KIMI_EXECUTABLE, path.join(os.homedir(), '.kimi-code', 'bin', 'kimi.exe')];
  for (const folder of (process.env.PATH || '').split(path.delimiter)) candidates.push(path.join(folder, 'kimi.exe'));
  return candidates.find(file => file && fs.existsSync(file));
}

function profileBody(root, mode) {
  const file = path.join(appDirectory(root), PROFILE_FILES[mode] || PROFILE_FILES.plan);
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
    return (match ? text.slice(match[0].length) : text).trim();
  } catch {
    return '';
  }
}

function prepareProfile(root, folder, mode) {
  const source = path.join(appDirectory(root), PROFILE_FILES[mode] || PROFILE_FILES.plan);
  if (!fs.existsSync(source)) throw new Error('缺少角色工坊 Kimi Agent 配置：' + source);
  const original = fs.readFileSync(source, 'utf8').replace(/^\uFEFF/, '');
  if (!/^---\r?\n/.test(original)) throw new Error('角色工坊 Kimi Agent 配置缺少工具权限定义。');
  // Kimi 2.1.1's ACP entry point ignores --agent-file. It does honor project
  // agent discovery. Shadow the built-in `agent` profile only within this
  // task's own working folder, keeping the original tool/subagent allowlist.
  const runtime = original.replace(/^name:\s*[^\r\n]+/m, 'name: agent\noverride: true');
  const directory = path.join(folder, '.kimi-code', 'agents');
  fs.mkdirSync(directory, { recursive: true });
  const destination = path.join(directory, 'character-studio.md');
  fs.writeFileSync(destination, runtime, 'utf8');
  return destination;
}

function acpErrorText(error) {
  const message = error && error.message ? String(error.message) : '未知错误';
  return message.length > 300 ? message.slice(0, 300) : message;
}

function updateText(update) {
  if (update && update.sessionUpdate === 'agent_message_chunk') {
    const content = update.content;
    if (content && content.type === 'text' && typeof content.text === 'string') return content.text;
  }
  return '';
}

function updateTool(update) {
  if (update && (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')) {
    return String(update.title || update.kind || '').slice(0, 120);
  }
  return '';
}

// Minimal newline-delimited JSON-RPC client for `kimi acp`.
class AcpClient {
  constructor(child, { onUpdate, onPermission, onStderr }) {
    this.child = child;
    this.onUpdate = onUpdate;
    this.onPermission = onPermission;
    this.onStderr = onStderr;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.closed = false;
    child.stdin.on('error', error => {
      this.closed = true;
      this.rejectAll(new Error('Kimi 进程连接已断开：' + acpErrorText(error)));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.consume(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', text => { if (this.onStderr) this.onStderr(String(text)); });
    child.on('close', () => { this.closed = true; this.rejectAll(new Error('Kimi 进程已结束。')); });
    child.on('error', error => { this.closed = true; this.rejectAll(error); });
  }

  rejectAll(error) {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
  }

  consume(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      this.dispatch(message);
    }
  }

  dispatch(message) {
    if (message.id != null && (message.result !== undefined || message.error !== undefined)) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(acpErrorText(message.error)));
      else entry.resolve(message.result);
      return;
    }
    if (message.id != null && message.method) {
      Promise.resolve()
        .then(() => this.handleServerRequest(message))
        .then(result => this.write({ jsonrpc: '2.0', id: message.id, result }))
        .catch(error => this.write({ jsonrpc: '2.0', id: message.id,
          error: { code: -32603, message: String(error && error.message).slice(0, 200) } }));
      return;
    }
    if (message.method === 'session/update') {
      const update = message.params && message.params.update;
      if (update && this.onUpdate) this.onUpdate(update);
    }
  }

  async handleServerRequest(message) {
    if (message.method === 'session/request_permission' && this.onPermission) {
      return this.onPermission(message.params) || { outcome: { outcome: 'cancelled' } };
    }
    // No filesystem or terminal capabilities are advertised, so the engine
    // handles those itself; anything else is answered as unsupported.
    throw new Error('不支持的请求：' + message.method);
  }

  write(message) {
    if (this.closed || !this.child.stdin.writable || this.child.stdin.destroyed || this.child.stdin.writableEnded) return false;
    try {
      this.child.stdin.write(JSON.stringify(message) + '\n');
      return true;
    } catch (error) {
      this.closed = true;
      this.rejectAll(error);
      return false;
    }
  }

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(new Error('Kimi 进程已结束。'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Kimi 未在预期时间内响应：' + method));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.write({ jsonrpc: '2.0', id, method, params })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Kimi 进程已结束。'));
      }
    });
  }

  dispose() {
    this.closed = true;
    this.rejectAll(new Error('Kimi 会话已结束。'));
    try { this.child.stdin.end(); } catch { /* already closed */ }
  }
}

class KimiRunner {
  constructor(bridge, emit) {
    this.bridge = bridge;
    this.emit = emit;
    this.process = null;
    this.client = null;
    this.run = null;
  }

  status() {
    const executable = kimiExecutable();
    return {
      installed: !!executable,
      executable,
      running: !!this.run || !!this.process,
      workflow: this.run?.workflow || null,
      progress: this.run?.progressStatus || null,
      launcher: path.join(this.bridge.root, 'Start Kimi Character Agent.cmd'),
      mcp_config: path.join(kimiHome(), 'mcp.json'),
      config_path: kimiConfigPath(),
    };
  }

  // Full catalog plus the saved selection, in the shape the renderer expects.
  async catalog() {
    const data = runCatalog(this.bridge.root);
    const saved = readSelection(this.bridge.data);
    let selection = saved;
    let notice = '';
    try {
      const resolved = resolveSelection(data, saved);
      selection = { provider: resolved.provider, model: resolved.model,
        thinking: resolved.thinking, effort: resolved.effort };
    } catch (error) {
      selection = { ...DEFAULT_SELECTION };
      notice = '已保存的模型选择不可用，已回到跟随 Kimi 默认：' + error.message;
    }
    return { ...data, selection, ...(notice ? { notice } : {}) };
  }

  // Validates against the live machine catalog, then persists the choice. The
  // global Kimi config, login state, and MCP settings are never touched.
  async setSelection(selection) {
    if (this.run || this.process) throw new Error('Kimi 正在处理任务，完成或停止后再切换模型。');
    const data = runCatalog(this.bridge.root);
    const resolved = resolveSelection(data, selection);
    const saved = saveSelection(this.bridge.data, {
      provider: resolved.provider, model: resolved.model,
      thinking: resolved.thinking, effort: resolved.effort,
    });
    return { ...data, selection: saved };
  }

  resolveForRun(selection) {
    const catalog = runCatalog(this.bridge.root);
    const requested = selection ? normalizeSelection(selection) : readSelection(this.bridge.data);
    const resolved = resolveSelection(catalog, requested);
    const thinking = planThinking(catalog, resolved);
    const provider = findProvider(catalog, resolved.provider);
    return { catalog, requested, resolved, thinking, provider };
  }

  // Safe launch description shared with the standalone terminal entry point.
  async launchSpec({ target = 'run', selection } = {}) {
    const executable = kimiExecutable();
    if (!executable) throw new Error('没有找到 Kimi Code，请先安装或设置 KIMI_EXECUTABLE。');
    const { catalog, requested, resolved, thinking, provider } = this.resolveForRun(selection);
    const baseEnv = { CHARACTER_STUDIO_ROOT: this.bridge.root, CHARACTER_STUDIO_DATA: this.bridge.data,
      CHARACTER_STUDIO_PORT: String(this.bridge.port) };
    if (target === 'terminal') {
      const spec = buildTerminalLaunch({ catalog, resolved, executable, env: baseEnv });
      return { target: 'terminal', executable, args: spec.args, env: spec.env,
        selection: requested, resolved, thinkingValue: spec.thinkingValue,
        thinkingHonored: spec.thinkingHonored, notice: spec.notice };
    }
    return { target: 'run', executable, args: ['acp'], env: baseEnv, selection: requested,
      resolved, thinkingValue: thinking.value, thinkingHonored: true,
      providerType: provider ? provider.type : '', notice: '' };
  }

  async start({ prompt, mode = 'plan', history = [], selection, stages: rawStages }) {
    if (this.run || this.process) throw new Error('Kimi 正在处理上一条任务。');
    const executable = kimiExecutable();
    if (!executable) throw new Error('没有找到 Kimi Code，请先安装或设置 KIMI_EXECUTABLE。');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 12000) throw new Error('请填写任务，长度不超过 12000 字。');
    if (!['plan', 'execute'].includes(mode)) throw new Error('无效的 Kimi 任务模式。');
    const stages = rawStages ? executionStages(rawStages) : null;
    if (stages && mode !== 'execute') throw new Error('步骤工作流必须使用执行模式。');
    const { requested, resolved, thinking, provider } = this.resolveForRun(selection);
    const run = { cancelled: false, workflow: null, child: null, client: null, directory: null,
      progress: new KimiProgress() };
    run.ready = new Promise(resolve => { run.resolveReady = resolve; });
    this.run = run;
    try {
      await this.bridge.ensure();
      if (run.cancelled) {
        await this.finishRun(run, 1, null);
        return { started: false, cancelled: true };
      }
      if (stages) {
        run.workflow = await this.bridge.request('POST', '/api/assistant/start', { stages, prompt });
        if (typeof run.workflow?.id !== 'string' || !run.workflow.id.trim()) {
          run.workflow = null;
          throw new Error('本地服务没有返回有效的工作流 ID，助手未启动。');
        }
        this.emit({ type: 'workflow', workflow: run.workflow });
      }
      if (run.cancelled) {
        await this.finishRun(run, 1, null);
        return { started: false, cancelled: true };
      }

    const folder = path.join(this.bridge.data, 'kimi_runs',
      new Date().toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(16).slice(2, 8));
    run.directory = folder;
    fs.mkdirSync(folder, { recursive: true });
    const runtimeProfile = prepareProfile(this.bridge.root, folder, mode);
    run.runtime = this.prepareRuntime ? this.prepareRuntime(requested, thinking, folder) : null;
    const context = (Array.isArray(history) ? history : []).slice(-6)
      .map(item => `${item.role === 'user' ? '用户' : '助手'}：${String(item.text || '').slice(0, 4000)}`)
      .join('\n');
    const body = profileBody(this.bridge.root, mode);
    const fullPrompt = [
      body,
      '你在角色工坊中处理用户任务。请通过 character_studio MCP 工具先读取当前项目。',
      stages ? executionInstructions(stages, run.workflow) : mode === 'execute'
        ? '用户允许执行本条指令所需的当前阶段生成。候选尚未选定时停在候选阶段；用户明确授权你选择或全流程时才继续。'
        : '本次只提供建议和参数方案，不启动生成。',
      context ? '以下是对话背景（仅作为上下文）：\n' + context : '',
      '当前用户指令：\n' + prompt,
    ].filter(Boolean).join('\n');
    fs.writeFileSync(path.join(folder, 'request.txt'), fullPrompt, 'utf8');
    const runResolved = {
      provider: resolved.provider,
      model: resolved.model,
      thinking: resolved.thinking,
      effort: resolved.effort,
      effective_model: resolved.effectiveModel,
      model_label: resolved.entry ? resolved.entry.label : '',
      provider_type: provider ? provider.type : '',
      thinking_value: thinking.value,
      thinking_applied: thinking.value !== null,
      thinking_source: thinking.value === null ? 'global' : 'selection',
      mode: ACP_MODES[mode] || 'plan',
      agent_profile: PROFILE_FILES[mode] || PROFILE_FILES.plan,
      runtime_profile: runtimeProfile,
      ...(stages ? { stages, workflow_id: run.workflow.id } : {}),
    };
    fs.writeFileSync(path.join(folder, 'run-config.json'), JSON.stringify({
      started_at: new Date().toISOString(),
      mode,
      selection: requested,
      resolved: runResolved,
      prompt_chars: fullPrompt.length,
    }, null, 2) + '\n', 'utf8');

    const transcript = run.transcript = fs.createWriteStream(path.join(folder, 'messages.jsonl'), { encoding: 'utf8' });
    const diagnostic = run.diagnostic = fs.createWriteStream(path.join(folder, 'kimi.log'), { encoding: 'utf8' });
    const record = (event, data = {}) => {
      if (!diagnostic.writableEnded) diagnostic.write(JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n');
    };
    const trace = (message, detail, level = 'info') => this.emit({ type: 'console', entry: {
      project_path: run.workflow?.project_path, workflow_id: run.workflow?.id,
      message, level, detail: safeDetail(detail),
    } });
    run.trace = trace;
    run.record = record;
    record('launch', { model: resolved.model, thinking: thinking.value });
    trace('启动 Kimi 执行助手', { model: resolved.model, thinking: thinking.value, stages, directory: folder });
    const child = spawn(executable, ['acp'], {
      cwd: folder,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(run.runtime?.env || {}), CHARACTER_STUDIO_ROOT: this.bridge.root,
        CHARACTER_STUDIO_DATA: this.bridge.data, CHARACTER_STUDIO_PORT: String(this.bridge.port),
        CHARACTER_STUDIO_WORKFLOW_ID: run.workflow?.id || '' },
    });
    run.child = child;
    this.process = child;

    const toolCalls = new Map();
    const client = new AcpClient(child, {
      onStderr: text => {
        if (!diagnostic.writableEnded) diagnostic.write(text);
        if (text.trim()) trace('Kimi 进程诊断', { output: text.trim() }, /error|failed|exception/i.test(text) ? 'error' : 'debug');
      },
      onUpdate: update => {
        if (run.finishing) return;
        run.progress.activity(update);
        const text = updateText(update);
        const tool = updateTool(update);
        if (tool) record('tool', { name: tool, status: update.status });
        if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
          const id = update.toolCallId;
          const previous = toolCalls.get(id) || { started: Date.now() };
          const call = { ...previous, name: update.title || previous.name || tool || '工坊工具', status: update.status || 'pending',
            input: update.rawInput ?? previous.input };
          toolCalls.set(id, call);
          if (previous.status !== call.status || update.rawInput) {
            const finished = ['completed', 'failed'].includes(call.status);
            const result = update.rawOutput ?? update.content?.filter(item => item.type === 'content' && item.content?.type === 'text')
              .map(item => item.content.text);
            trace(`${{ pending: '准备调用', in_progress: '正在执行', completed: '调用完成', failed: '调用失败' }[call.status] || '工具状态'} · ${call.name}`,
              { tool_call_id: id, status: call.status, input: call.input,
                ...(finished ? { elapsed_ms: Date.now() - call.started, result } : {}) }, call.status === 'failed' ? 'error' : finished ? 'success' : 'info');
          }
        }
        if (!text && !tool) return;
        const packet = { role: 'assistant', text: text.slice(0, 24000), tools: tool ? [tool] : [] };
        transcript.write(JSON.stringify(packet) + '\n');
        this.emit({ type: 'message', ...packet });
      },
      // The custom agent's tool allowlist is authoritative. If the CLI also
      // requests permission, choose an offered one-time approval only for tools
      // that belong to this mode; arbitrary terminal/file writes are rejected.
      onPermission: params => permissionFor(mode, params),
    });
    run.client = client;
    this.client = client;

    (async () => {
      try {
        record('initialize');
        trace('连接 Kimi ACP 会话');
        await client.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        });
        const session = await client.request('session/new', { cwd: folder, mcpServers: [] });
        const sessionId = session.sessionId;
        record('session', { session_id: sessionId });
        trace('Kimi 会话已连接', { session_id: sessionId });
        if (!sessionId) throw new Error('Kimi 没有返回会话 ID。');
        let options = Array.isArray(session.configOptions) ? session.configOptions : [];
        const hasOption = id => options.some(option => option.id === id);
        const setOption = async (configId, value) => {
          const result = await client.request('session/set_config_option', { sessionId, configId, value });
          if (Array.isArray(result?.configOptions)) options = result.configOptions;
        };

        if (resolved.model) {
          if (!hasOption('model')) throw new Error('当前 Kimi 版本不支持在会话中选择模型。');
          await setOption('model', resolved.model);
        }
        if (thinking.value !== null) {
          if (!hasOption('thinking')) {
            throw new Error('模型 ' + (resolved.effectiveModel || '默认')
              + ' 在当前 Kimi 会话里没有思考选项，无法应用所选的思考设置。');
          }
          // An unsupported value is rejected by the CLI; surface that instead of
          // silently falling back to the global thinking configuration.
          await setOption('thinking', thinking.value);
        }
        const acpMode = ACP_MODES[mode] || 'plan';
        if (hasOption('mode')) {
          await setOption('mode', acpMode);
        } else {
          throw new Error('当前 Kimi 版本没有任务模式选项，无法应用只读或执行模式。');
        }
        this.emit({ type: 'started', mode, directory: folder, selection: requested, resolved: runResolved, workflow: run.workflow, stages: stages || [] });
        record('prompt_sent');
        trace('任务已发送，等待模型执行', { model: resolved.model, thinking: thinking.value, prompt_chars: fullPrompt.length });
        run.progress.lastActivity = run.progress.lastProgress = Date.now();
        this.startProgressMonitor(run);
        await client.request('session/prompt', {
          sessionId, prompt: [{ type: 'text', text: fullPrompt }],
        }, 24 * 60 * 60 * 1000);
        await this.finishRun(run, 0, null);
      } catch (error) {
        await this.finishRun(run, 1, error && error.message ? error.message : String(error));
      }
    })();

    return { started: true, directory: folder, selection: requested, resolved: runResolved, workflow: run.workflow, stages: stages || [] };
    } catch (error) {
      await this.finishRun(run, 1, error.message || String(error));
      if (run.cancelled) return { started: false, cancelled: true };
      throw error;
    } finally {
      run.resolveReady();
    }
  }

  startProgressMonitor(run) {
    const tick = async () => {
      if (run.finishing || run.checkingProgress) return;
      run.checkingProgress = true;
      try {
        // Check job ownership before any timeout decision. If the local service
        // is unreachable we cannot safely assume that generation has stopped.
        const state = run.workflow ? await this.bridge.request('GET', '/api/state') : null;
        if (run.finishing) return;
        if (run.workflow && !state.assistant?.id) throw new Error('工作流状态暂时缺失，继续核实本地任务。');
        if (run.workflow && (state.assistant.id !== run.workflow.id || state.assistant.status !== 'running')) {
          const own = state.assistant?.id === run.workflow.id;
          const complete = own && state.assistant.status === 'complete';
          if (own && state.assistant.status === 'cancelled') run.cancelled = true;
          await this.finishRun(run, complete ? 0 : 1, complete ? null : '工作流已经结束或被停止。');
          return;
        }
        const progress = run.progress.snapshot(state, run.workflow?.id);
        run.progressStatus = progress;
        this.emit({ type: 'progress', ...progress });
        run.record?.('progress', progress);
        const marker = `${progress.phase}:${progress.job_id}:${progress.node_type}:${!!progress.warning}:${Math.floor(progress.idle_seconds / 30)}`;
        if (run.progressMarker !== marker) {
          run.progressMarker = marker;
          run.trace?.(progress.label, { elapsed_seconds: progress.elapsed_seconds, idle_seconds: progress.idle_seconds,
            thought_chunks: progress.thought_chunks, execution_kind: progress.execution_kind,
            job_id: progress.job_id, prompt_id: progress.prompt_id, node_type: progress.node_type,
            warning: progress.warning }, progress.error ? 'error' : progress.warning ? 'warn' : 'info');
        }
        if (progress.error) await this.finishRun(run, 1, progress.error);
      } catch (error) {
        if (!run.finishing) {
          const progress = { ...run.progress.snapshot(null, run.workflow?.id),
            phase: 'service_unavailable', label: '本地任务状态暂时不可用，正在重新连接' };
          run.progressStatus = progress;
          this.emit({ type: 'progress', ...progress });
          run.record?.('state_check_failed', { message: acpErrorText(error) });
        }
      } finally { run.checkingProgress = false; }
    };
    run.progressTimer = setInterval(tick, 5000);
    tick();
  }

  async finishRun(run, code, error) {
    if (run.finishing) return run.finished;
    run.finishing = true;
    clearInterval(run.progressTimer);
    run.finished = (async () => {
      run.client?.dispose();
      try { run.child?.kill(); } catch { /* already gone */ }
      let failure = error || null;
      if (run.workflow) {
        try {
          if (run.cancelRequest) await run.cancelRequest;
          run.workflow = await this.bridge.request('POST', '/api/assistant/finish', {
            workflow_id: run.workflow.id,
            status: run.cancelled ? 'cancelled' : code ? 'error' : 'complete',
            ...(failure && !run.cancelled ? { message: failure } : {}),
          });
          this.emit({ type: 'workflow', workflow: run.workflow });
          if (!run.cancelled && run.workflow.status !== 'complete') {
            code = 1;
            failure = run.workflow.message || failure || '所选步骤尚未全部完成。';
          }
        } catch (finishError) {
          code = 1;
          failure = '无法确认工作流结束状态：' + finishError.message;
        }
      }
      if (this.process === run.child) this.process = null;
      if (this.client === run.client) this.client = null;
      if (this.run === run) this.run = null;
      run.record?.('finished', { code, cancelled: run.cancelled, error: failure });
      run.trace?.(run.cancelled ? '助手执行已停止' : code ? '助手执行失败' : '助手已完成所选步骤',
        { code, error: failure, directory: run.directory }, run.cancelled ? 'warn' : code ? 'error' : 'success');
      run.transcript?.end();
      run.diagnostic?.end();
      run.runtime?.cleanup();
      const packet = { type: 'done', code, cancelled: run.cancelled, directory: run.directory,
        workflow: run.workflow,
        error: run.cancelled ? null : failure || (code ? 'Kimi 未完成本次任务，请查看 Kimi 日志；检查登录、配额或连接状态。' : null) };
      this.emit(packet);
      return packet;
    })();
    return run.finished;
  }

  async cancel() {
    const run = this.run;
    if (run) {
      if (run.finishing) {
        const done = await run.finished;
        return { cancelled: done.cancelled, workflow: done.workflow };
      }
      run.cancelled = true;
      try {
        // A stop may arrive while the service is still accepting the workflow.
        // Let setup observe cancellation and settle before a window can close.
        if (!run.child && !run.workflow && run.ready) await run.ready;
        if (run.workflow && !['complete', 'error', 'cancelled', 'interrupted'].includes(run.workflow.status)) {
          run.cancelRequest ||= this.bridge.request('POST', '/api/assistant/cancel', { workflow_id: run.workflow.id });
          run.workflow = await run.cancelRequest;
          this.emit({ type: 'workflow', workflow: run.workflow });
        }
      } finally {
        run.client?.dispose();
        try { run.child?.kill(); } catch { /* already gone */ }
      }
      return { cancelled: true, workflow: run.workflow };
    }
    // Recover the stop action after reopening a window whose workflow state is
    // still active in the service. Only the recorded workflow's job is touched.
    if (typeof this.bridge.request !== 'function') return { cancelled: true, workflow: null };
    const state = await this.bridge.request('GET', '/api/state');
    const workflow = state.assistant?.status === 'running'
      ? await this.bridge.request('POST', '/api/assistant/cancel', { workflow_id: state.assistant.id }) : state.assistant;
    if (workflow) this.emit({ type: 'workflow', workflow });
    return { cancelled: true, workflow: workflow || null };
  }
}

module.exports = { KimiRunner, AcpClient, permissionFor, kimiExecutable, buildTerminalLaunch, kimiConfigPath, kimiHome };
