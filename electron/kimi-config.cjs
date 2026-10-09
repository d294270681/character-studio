// Kimi Code provider/model catalog + saved selection for the character studio.
//
// Reads only whitelisted metadata (see ../../kimi_config.py): credentials, base
// URLs, OAuth references, and custom headers never reach this process.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { appDirectory, runtimePaths } = require('./runtime-paths.cjs');

const THINKING_VALUES = ['default', 'on', 'off'];
const DEFAULT_SELECTION = { provider: '', model: '', thinking: 'default', effort: 'default' };

function kimiHome() {
  return process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
}

function kimiConfigPath() {
  return path.join(kimiHome(), 'config.toml');
}

function pythonExecutable(root) {
  const python = runtimePaths(root).python;
  return fs.existsSync(python) ? python : null;
}

function catalogScript(root) {
  return path.join(appDirectory(root), 'kimi_config.py');
}

function runCatalog(root, configPath, timeout = 30000) {
  const python = pythonExecutable(root);
  const script = catalogScript(root);
  if (!python) throw new Error('没有找到本地 Python 运行环境，无法读取 Kimi 配置。');
  if (!fs.existsSync(script)) throw new Error('缺少 Kimi 配置读取脚本：' + script);
  const args = ['-B', '-s', script];
  if (configPath) args.push('--config', configPath);
  const result = spawnSync(python, args, {
    cwd: path.dirname(script),
    windowsHide: true,
    timeout,
    encoding: 'utf8',
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw new Error('读取 Kimi 配置失败：' + result.error.message);
  const stdout = String(result.stdout || '').trim();
  let payload = null;
  try { payload = JSON.parse(stdout.split('\n').filter(Boolean).pop() || ''); } catch { payload = null; }
  if (payload && payload.error) throw new Error(payload.error);
  if (!payload || !Array.isArray(payload.models)) {
    const detail = String(result.stderr || '').trim().split('\n').filter(Boolean).pop();
    throw new Error('读取 Kimi 配置失败' + (detail ? '：' + detail.slice(0, 200) : '。'));
  }
  return payload;
}

function normalizeSelection(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    provider: typeof source.provider === 'string' ? source.provider.trim() : '',
    model: typeof source.model === 'string' ? source.model.trim() : '',
    thinking: THINKING_VALUES.includes(source.thinking) ? source.thinking : 'default',
    effort: typeof source.effort === 'string' && source.effort.trim() ? source.effort.trim() : 'default',
  };
}

function selectionPath(dataDir) {
  return path.join(dataDir, 'kimi-selection.json');
}

function readSelection(dataDir) {
  try {
    return normalizeSelection(JSON.parse(fs.readFileSync(selectionPath(dataDir), 'utf8')));
  } catch {
    return { ...DEFAULT_SELECTION };
  }
}

function saveSelection(dataDir, selection) {
  const normalized = normalizeSelection(selection);
  fs.mkdirSync(dataDir, { recursive: true });
  const target = selectionPath(dataDir);
  const temporary = target + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, target);
  return normalized;
}

function findModel(catalog, id) {
  if (!id) return null;
  return (catalog.models || []).find(model => model.id === id) || null;
}

function findProvider(catalog, id) {
  if (!id) return null;
  return (catalog.providers || []).find(provider => provider.id === id) || null;
}

// Resolves a requested selection against the live catalog. Empty provider/model
// mean "follow Kimi's default"; anything that no longer exists is an error, so a
// deleted or unsupported model can never be silently swapped out.
function resolveSelection(catalog, selection) {
  const requested = normalizeSelection(selection);
  let provider = requested.provider;
  let model = requested.model;
  if (!provider && model) provider = (findModel(catalog, model) || {}).provider || '';
  if (provider) {
    if (!findProvider(catalog, provider)) throw new Error('选择的提供方已不存在：' + provider);
    if (!model) model = ((catalog.models || []).find(item => item.provider === provider) || {}).id || '';
    if (!model) throw new Error('提供方下没有可用模型：' + provider);
    const entry = findModel(catalog, model);
    if (!entry) throw new Error('选择的模型已不存在：' + model);
    if (entry.provider !== provider) throw new Error('模型 ' + model + ' 不属于提供方 ' + provider + '。');
  }
  const effectiveModel = model || catalog.default_model || '';
  const entry = findModel(catalog, effectiveModel);
  const thinking = requested.thinking;
  const effort = requested.effort;
  // `false` is a hard "this model does not support it"; `null` means the entry
  // declares no capabilities at all, so the CLI decides at run time.
  if (thinking === 'off') {
    if (!entry) throw new Error('无法确认默认模型是否支持关闭思考，请先指定模型。');
    if (entry.thinking_supported === false) throw new Error('模型 ' + entry.id + ' 不支持思考设置。');
    if (entry.can_disable_thinking === false) throw new Error('模型 ' + entry.label + ' 始终开启思考，无法关闭。');
    if (effort !== 'default') throw new Error('关闭思考时不能同时指定思考等级。');
  }
  if (thinking === 'on' && !entry) throw new Error('无法确认默认模型是否支持思考，请先指定模型。');
  if (thinking === 'on' && entry && entry.thinking_supported === false) {
    throw new Error('模型 ' + entry.label + ' 不支持思考设置。');
  }
  if (effort !== 'default') {
    if (!entry) throw new Error('无法确认默认模型的思考等级，请先指定模型。');
    if (entry.thinking_supported === false) throw new Error('模型 ' + entry.label + ' 不支持思考等级。');
    if (thinking === 'off') throw new Error('关闭思考时不能同时指定思考等级。');
    const allowed = entry.support_efforts;
    if (!Array.isArray(allowed) || !allowed.length) {
      throw new Error('模型 ' + entry.label + ' 没有声明思考等级，只能跟随默认。');
    }
    if (!allowed.includes(effort)) {
      throw new Error('模型 ' + entry.label + ' 不支持等级 ' + effort + '，可选：' + allowed.join('、'));
    }
  }
  return { provider, model, thinking, effort, effectiveModel, entry };
}

// Concrete value handed to the CLI. `null` means "leave Kimi's global setting".
function planThinking(catalog, resolved) {
  if (resolved.thinking === 'default' && resolved.effort === 'default') {
    return { value: null, requested: 'default' };
  }
  if (resolved.thinking === 'off') return { value: 'off', requested: 'off' };
  if (resolved.effort !== 'default') return { value: resolved.effort, requested: 'on' };
  const efforts = resolved.entry?.support_efforts;
  // Boolean-only models expose `on` in ACP, not an arbitrary global effort.
  // Effort-aware models use their own declared default, with the ACP engine's
  // middle-entry fallback when no default was declared.
  const fallback = Array.isArray(efforts) && efforts.length
    ? resolved.entry.default_effort || efforts[Math.floor(efforts.length / 2)]
    : 'on';
  return { value: fallback, requested: 'on' };
}

// Shared by the in-app run and the standalone terminal launcher. Only the `kimi`
// protocol honours KIMI_MODEL_THINKING_EFFORT, so the result reports whether the
// thinking request can travel with CLI options and why it cannot when it cannot.
function buildTerminalLaunch({ catalog, resolved, executable, env }) {
  const provider = findProvider(catalog, resolved.provider);
  const args = [];
  if (resolved.model) args.push('-m', resolved.model);
  const thinking = planThinking(catalog, resolved);
  const launchEnv = { ...env };
  let thinkingHonored = true;
  let notice = '';
  if (thinking.value) {
    if (provider && provider.type === 'kimi') {
      launchEnv.KIMI_MODEL_THINKING_EFFORT = thinking.value;
    } else {
      thinkingHonored = false;
      notice = '终端启动无法覆盖该提供方（' + (provider ? provider.type : '默认')
        + '）的思考设置，会跟随 Kimi 全局配置；需要精确控制请在本工具的对话里执行。';
    }
  }
  return { executable, args, env: launchEnv, resolved, thinkingHonored, notice, thinkingValue: thinking.value };
}

module.exports = {
  THINKING_VALUES, DEFAULT_SELECTION,
  kimiHome, kimiConfigPath, pythonExecutable, catalogScript, runCatalog,
  normalizeSelection, selectionPath, readSelection, saveSelection,
  findModel, findProvider, resolveSelection, planThinking, buildTerminalLaunch,
};
