const fs = require('node:fs');
const path = require('node:path');
const { appDirectory } = require('./runtime-paths.cjs');
const { spawn } = require('node:child_process');
const { kimiExecutable } = require('./kimi.cjs');

const quote = value => "'" + String(value).replace(/'/g, "''") + "'";
const TITLE = 'Character Studio - Kimi Code';

function terminalScript({ executable, root, runtime, model }) {
  const agent = path.join(appDirectory(root), 'kimi-character-assistant.md');
  const cleanup = ['config.toml', 'mcp.json'].map(file =>
    'Remove-Item -LiteralPath ' + quote(path.join(runtime.home, file)) + ' -Force -ErrorAction SilentlyContinue').join('\n');
  return [
    '$ErrorActionPreference = "Continue"',
    // Node/libuv asserts on an empty inherited console title on Windows.
    '$Host.UI.RawUI.WindowTitle = ' + quote(TITLE),
    'Set-Location -LiteralPath ' + quote(root),
    'try { & ' + quote(executable) + ' --agent-file ' + quote(agent) + ' --model ' + quote(model) + ' }',
    'finally {', cleanup,
    'Remove-Item Env:CHARACTER_STUDIO_PROVIDER_KEY -ErrorAction SilentlyContinue', '}',
    'Read-Host "Kimi exited. Press Enter to close" | Out-Null',
  ].join('\n');
}

async function openKimiTerminal(runner, { spawnImpl = spawn } = {}) {
  const executable = kimiExecutable();
  if (!executable) throw new Error('没有找到 Kimi Code。');
  await runner.providers?.autoMetadata();
  const { requested, resolved, thinking } = runner.resolveForRun();
  const directory = path.join(runner.bridge.data, 'kimi_terminals', new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid + '-' + Math.random().toString(16).slice(2, 8));
  fs.mkdirSync(directory, { recursive: true });
  const runtime = runner.prepareRuntime(requested, thinking, directory);
  if (!runtime) throw new Error('模型配置尚未初始化。');
  const env = { ...process.env, ...runtime.env, CHARACTER_STUDIO_ROOT: runner.bridge.root,
    CHARACTER_STUDIO_DATA: runner.bridge.data, CHARACTER_STUDIO_PORT: String(runner.bridge.port) };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_CHANNEL_FD']) delete env[key];
  const args = ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(terminalScript({ executable, root: runner.bridge.root,
    runtime, model: resolved.model }), 'utf16le').toString('base64')];
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // `start` allocates a real console. A detached PowerShell by itself can have
  // no console at all. The nonempty title avoids libuv's uv_get_process_title
  // assertion; /wait keeps our wrapper alive until the visible terminal ends.
  const child = spawnImpl(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start', '/wait', TITLE, shell, ...args],
    { cwd: runner.bridge.root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env });
  let diagnostic = '';
  child.stderr?.on('data', chunk => { diagnostic += chunk.toString(); });
  child.once('exit', () => runtime.cleanup());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 300);
    child.once('error', error => { clearTimeout(timer); runtime.cleanup(); reject(error); });
    child.once('exit', code => { if (code) { clearTimeout(timer); reject(new Error('终端启动失败：' + diagnostic.slice(0, 300))); } });
  });
  child.unref();
  child.stderr?.unref();
  return { opened: true, model: resolved.model, thinkingHonored: true };
}

module.exports = { openKimiTerminal, terminalScript, TITLE };
