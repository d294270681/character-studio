const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { findRoot, runtimePaths } = require('./runtime-paths.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
class StudioBridge {
  constructor(root = findRoot(), options = {}) {
    this.runtime = runtimePaths(root);
    this.root = this.runtime.app;
    this.data = options.data || this.runtime.data;
    this.port = options.port || Number(process.env.CHARACTER_STUDIO_PORT || 8190);
    this.ready = null;
    this.descriptor = null;
  }
  async ensure() {
    if (this.ready) return this.ready;
    this.ready = this.connect().catch(error => { this.ready = null; throw error; });
    return this.ready;
  }
  async connect() {
    try {
      this.descriptor = JSON.parse(fs.readFileSync(path.join(this.data, 'service.json'), 'utf8'));
      const url = new URL(this.descriptor.url);
      if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('无效的本地服务地址。');
      await this.requestRaw('GET', '/api/state', null, 2000);
      return;
    } catch { this.descriptor = null; }
    fs.mkdirSync(this.data, { recursive: true });
    const python = this.runtime.python;
    const script = path.join(this.root, 'studio_service.py');
    if (!fs.existsSync(python) || !fs.existsSync(script)) throw new Error('本地运行环境缺失，请先运行项目的环境配置入口，或检查 config/runtime.local.json。');
    const log = fs.openSync(path.join(this.data, 'service.log'), 'a');
    const env = { ...process.env, CHARACTER_STUDIO_ROOT: this.root, CHARACTER_STUDIO_DATA: this.data,
      PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
    for (const key of ['PYTHONHOME', 'PYTHONPATH', 'QT_PLUGIN_PATH', 'QT_QPA_PLATFORM_PLUGIN_PATH']) delete env[key];
    const child = spawn(python, ['-B', '-s', script, '--port', String(this.port), '--data-dir', this.data],
      { cwd: path.dirname(script), env, windowsHide: true, detached: true, stdio: ['ignore', log, log] });
    fs.closeSync(log);
    let launchError;
    child.on('error', error => { launchError = error; });
    child.unref();
    for (let attempt = 0; attempt < 100; attempt++) {
      if (launchError) throw launchError;
      await sleep(150);
      try {
        this.descriptor = JSON.parse(fs.readFileSync(path.join(this.data, 'service.json'), 'utf8'));
        if (new URL(this.descriptor.url).hostname !== '127.0.0.1') throw new Error('无效的服务地址。');
        await this.requestRaw('GET', '/api/state', null, 1000);
        return;
      } catch { /* The service may still be starting, or another client won the bind. */ }
    }
    throw new Error('无法连接本地任务服务，请查看 ' + path.join(this.data, 'service.log'));
  }
  async requestRaw(method, route, body, timeout = 30000) {
    if (!this.descriptor) throw new Error('任务服务尚未启动。');
    const response = await fetch(this.descriptor.url + route, {
      method, headers: { Authorization: 'Bearer ' + this.descriptor.token, 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `任务服务返回 ${response.status}`);
    return data;
  }
  async request(method, route, body = null) {
    await this.ensure();
    try { return await this.requestRaw(method, route, body); }
    catch (error) {
      if (error.cause || error.name === 'TimeoutError') this.ready = null;
      throw error;
    }
  }
}

module.exports = { StudioBridge, findRoot, sleep };
