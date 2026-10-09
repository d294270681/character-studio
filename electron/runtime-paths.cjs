// Keep the desktop launcher and Python backend on the same local path settings.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function appDirectory(root) {
  const folder = path.resolve(root);
  if (fs.existsSync(path.join(folder, 'studio_service.py'))) return folder;
  const legacy = path.join(folder, 'tools', 'character-studio');
  return fs.existsSync(path.join(legacy, 'studio_service.py')) ? legacy : folder;
}

function findRoot(start = __dirname) {
  if (process.env.CHARACTER_STUDIO_ROOT) return appDirectory(process.env.CHARACTER_STUDIO_ROOT);
  let folder = path.resolve(start);
  while (true) {
    const app = appDirectory(folder);
    if (fs.existsSync(path.join(app, 'studio_service.py'))) return app;
    const parent = path.dirname(folder);
    if (folder === parent) throw new Error('Character Studio source directory was not found.');
    folder = parent;
  }
}

function runtimePaths(root = findRoot(), env = process.env) {
  const app = appDirectory(root);
  const candidate = path.resolve(app, '..', '..');
  const legacy = app === path.join(candidate, 'tools', 'character-studio') &&
    fs.existsSync(path.join(candidate, 'projects', 'pixel-farm-starter', 'project.godot')) ? candidate : null;
  const configPath = path.resolve(app, env.CHARACTER_STUDIO_CONFIG || 'config/runtime.local.json');
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')) : {};
  if (!config || Array.isArray(config) || typeof config !== 'object' || (config.schema_version ?? 1) !== 1)
    throw new Error('runtime.local.json must be an object with schema_version 1.');
  const available = (primary, fallback) => fs.existsSync(primary) || !fallback || !fs.existsSync(fallback) ? primary : fallback;
  function localPath(key, fallback, variable) {
    const value = (variable && env[variable]) || (Object.hasOwn(config, key) ? config[key] : fallback);
    if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid runtime path: ' + key);
    const expanded = /^~(?:[\\/]|$)/.test(value) ? path.join(os.homedir(), value.slice(1)) : value;
    return path.resolve(app, expanded);
  }
  const portable = legacy && path.join(legacy, 'tools', 'ComfyUI_windows_portable_nvidia', 'ComfyUI_windows_portable');
  const venv = path.join(app, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const legacyData = legacy && path.join(legacy, 'asset_pipeline', 'character_studio');
  return { app, configPath,
    python: localPath('python', available(venv, portable && path.join(portable, 'python_embeded', 'python.exe')), 'CHARACTER_STUDIO_PYTHON'),
    data: localPath('data_dir', legacyData && fs.existsSync(legacyData) ? legacyData : path.join(app, 'data'), 'CHARACTER_STUDIO_DATA'),
  };
}

module.exports = { appDirectory, findRoot, runtimePaths };
