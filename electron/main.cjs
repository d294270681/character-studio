const { app, BrowserWindow, ipcMain, dialog, protocol, shell, clipboard, screen, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { StudioBridge, findRoot } = require('./bridge.cjs');
const { StudioKimiRunner } = require('./studio-kimi.cjs');
const { ProviderManager } = require('./providers.cjs');
const { openKimiTerminal } = require('./kimi-terminal.cjs');
const { ExecutionConsole } = require('./execution-console.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'studio-media', privileges: { standard: true, secure: true,
  supportFetchAPI: true, stream: true, corsEnabled: true } }]);
const root = findRoot(app.getAppPath());
const bridge = new StudioBridge(root);
fs.mkdirSync(path.join(bridge.data, 'electron-profile'), { recursive: true });
app.setPath('userData', path.join(bridge.data, 'electron-profile'));
let window, quitting = false, closing = false, resolveFlush;
const executionConsole = new ExecutionConsole(bridge.data, packet => {
  if (window && !window.isDestroyed()) window.webContents.send('console:event', packet);
});
const providers = new ProviderManager(bridge, { secureStorage: safeStorage, busy: () => kimi.status().running });
const kimi = new StudioKimiRunner(bridge, packet => {
  if (packet.type === 'console') { executionConsole.add(packet.entry); return; }
  if (window && !window.isDestroyed()) window.webContents.send('kimi:event', packet);
}, providers);
let projectFolder = path.join(bridge.data, 'projects');

function inside(file, folder) {
  const relative = path.relative(path.resolve(folder), path.resolve(file));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
function trusted(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
    throw new Error('无效的界面请求。');
}
function handle(name, callback) {
  ipcMain.handle(name, async (event, ...args) => { trusted(event); return callback(...args); });
}
async function recordFor(stage, id) {
  const state = await bridge.request('GET', '/api/state');
  const record = state.project.assets[stage]?.find(item => item.id === id);
  if (!record) throw new Error('找不到所选资源。');
  return record;
}
const allowedRoute = (method, route) => typeof route === 'string' && (
  method === 'GET' && (['/api/state', '/api/projects'].includes(route) || /^\/api\/jobs\/[\w-]+$/.test(route)) ||
  method === 'POST' && (['/api/projects', '/api/projects/rename', '/api/settings', '/api/view', '/api/prepare', '/api/jobs', '/api/assets/select', '/api/assets/inspect'].includes(route) || /^\/api\/jobs\/[\w-]+\/cancel$/.test(route)));

async function media(request) {
  try {
    const url = new URL(request.url);
    const file = path.resolve(url.searchParams.get('path') || '');
    if ((!inside(file, path.join(bridge.data, 'projects')) && !inside(file, projectFolder)) || !fs.statSync(file).isFile()) return new Response('Not found', { status: 404 });
    const size = fs.statSync(file).size;
    const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
      '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };
    const type = types[path.extname(file).toLowerCase()];
    if (!type) return new Response('Unsupported media', { status: 415 });
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' };
    const range = request.headers.get('range');
    let start = 0, end = size - 1, status = 200;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      if (!match[1]) start = Math.max(0, size - Number(match[2]));
      else start = Number(match[1]);
      end = match[2] && match[1] ? Math.min(end, Number(match[2])) : end;
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['Content-Length'] = String(end - start + 1);
    return new Response(request.method === 'HEAD' ? null : Readable.toWeb(fs.createReadStream(file, { start, end })), { status, headers });
  } catch { return new Response('Not found', { status: 404 }); }
}

function registerHandlers() {
  handle('console:state', () => executionConsole.state());
  handle('console:clear', () => executionConsole.clear());
  handle('studio:api', async (method, route, body) => {
    if (!allowedRoute(method, route)) throw new Error('不支持的界面操作。');
    const result = await bridge.request(method, route, body);
    if (result.project?.folder) projectFolder = result.project.folder;
    return result;
  });
  handle('studio:import', async stage => {
    const isVideo = stage === 'video';
    const result = await dialog.showOpenDialog(window, { title: isVideo ? '导入视频' : '导入参考图', properties: ['openFile'],
      filters: [{ name: isVideo ? '视频' : '图片', extensions: isVideo ? ['mp4', 'mov', 'webm', 'mkv', 'avi'] : ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }] });
    if (result.canceled) return null;
    return bridge.request('POST', '/api/assets/import', { stage, path: result.filePaths[0] });
  });
  handle('studio:importPaths', async (stage, paths) => {
    if (!Array.isArray(paths) || paths.length !== 1 || typeof paths[0] !== 'string') throw new Error('请每次拖入一个参考文件。');
    return bridge.request('POST', '/api/assets/import', { stage, path: paths[0] });
  });
  handle('studio:openProject', async () => {
    const result = await dialog.showOpenDialog(window, { title: '打开角色项目', defaultPath: path.join(bridge.data, 'projects'),
      properties: ['openFile'], filters: [{ name: '角色项目 project.json', extensions: ['json'] }] });
    if (result.canceled) return null;
    const state = await bridge.request('POST', '/api/projects/open', { path: result.filePaths[0] });
    projectFolder = state.project.folder;
    return state;
  });
  handle('studio:saveAsset', async (stage, id) => {
    const record = await recordFor(stage, id);
    if (stage === 'sprites') {
      const result = await dialog.showOpenDialog(window, { title: '选择保存精灵图包的文件夹', properties: ['openDirectory', 'createDirectory'] });
      if (result.canceled) return null;
      return bridge.request('POST', '/api/assets/save', { stage, asset_id: id, package: true,
        destination: path.join(result.filePaths[0], 'sprites-' + id.slice(0, 8)) });
    }
    const result = await dialog.showSaveDialog(window, { title: '保存结果', defaultPath: path.basename(record.path, path.extname(record.path)) + (stage === 'video' ? '.mp4' : '.png'),
      filters: [{ name: stage === 'video' ? '视频' : '图片', extensions: [stage === 'video' ? 'mp4' : 'png'] }] });
    if (result.canceled) return null;
    return bridge.request('POST', '/api/assets/save', { stage, asset_id: id, destination: result.filePath });
  });
  handle('studio:showAsset', async (stage, id) => { const record = await recordFor(stage, id); shell.showItemInFolder(record.path); });
  handle('studio:metadata', async id => {
    const record = await recordFor('sprites', id);
    if (!record.metadata || (!inside(record.metadata, path.join(bridge.data, 'projects')) && !inside(record.metadata, projectFolder))) throw new Error('缺少精灵动画元数据。');
    return JSON.parse(fs.readFileSync(record.metadata, 'utf8'));
  });
  handle('studio:help', () => shell.openPath(path.join(root, '使用说明.txt')));
  handle('studio:copyText', text => { if (typeof text !== 'string' || text.length > 100000) throw new Error('无效文本。'); clipboard.writeText(text); });
  handle('studio:flushComplete', () => { resolveFlush?.(); return { saved: true }; });
  handle('kimi:status', () => kimi.status());
  handle('kimi:catalog', () => kimi.catalog());
  handle('kimi:selection', selection => kimi.setSelection(selection));
  handle('kimi:providers', (action, payload) => providers.action(action, payload));
  handle('kimi:start', request => kimi.start(request));
  handle('kimi:cancel', () => kimi.cancel());
  handle('kimi:terminal', () => openKimiTerminal(kimi));
}

async function createWindow() {
  const isVerification = process.env.CHARACTER_STUDIO_VERIFY === '1';
  const area = screen.getPrimaryDisplay().workAreaSize;
  window = new BrowserWindow({ width: Math.max(1120, Math.min(1510, area.width - 40)), height: Math.max(760, Math.min(990, area.height - 60)), minWidth: 1120, minHeight: 760,
    title: '角色工坊', backgroundColor: '#101315', show: false,
    icon: path.join(root, 'studio.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true,
      devTools: isVerification, offscreen: isVerification, backgroundThrottling: !isVerification } });
  if (isVerification) window.webContents.setFrameRate(30);
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.once('ready-to-show', () => { if (!isVerification || process.env.CHARACTER_STUDIO_SHOW === '1') window.show(); });
  window.on('close', async event => {
    if (quitting) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    if (kimi.status().running) {
      const choice = await dialog.showMessageBox(window, { type: 'question', buttons: ['继续使用', '停止助手及生成并关闭'], defaultId: 0, cancelId: 0,
        message: 'Kimi 仍在执行任务。', detail: '关闭会停止助手及它当前提交的生成任务，已经完成的候选会保留。' });
      if (choice.response !== 1) { closing = false; return; }
      try { await kimi.cancel(); }
      catch (error) { dialog.showErrorBox('未能停止助手任务', error.message); closing = false; return; }
    }
    await new Promise(resolve => {
      const timeout = setTimeout(resolve, 2000);
      resolveFlush = () => { clearTimeout(timeout); resolve(); };
      window.webContents.send('studio:flush');
    });
    resolveFlush = null;
    quitting = true;
    window.close();
  });
  await window.loadFile(path.join(__dirname, 'ui', 'index.html'));
}

async function openArgumentProject(argv) {
  const index = argv.indexOf('--project');
  if (index >= 0 && argv[index + 1]) {
    const state = await bridge.request('POST', '/api/projects/open', { path: path.resolve(argv[index + 1]) });
    projectFolder = state.project.folder;
  }
}

if (!app.requestSingleInstanceLock({ root })) app.quit();
else {
  app.on('second-instance', (_event, argv) => {
    openArgumentProject(argv).catch(error => dialog.showErrorBox('无法打开角色项目', error.message));
    if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
  });
  app.whenReady().then(async () => {
    protocol.handle('studio-media', media); registerHandlers(); await openArgumentProject(process.argv); await createWindow();
  }).catch(error => {
    fs.appendFileSync(path.join(bridge.data, 'electron-startup.log'), String(error.stack) + '\n');
    dialog.showErrorBox('角色工坊启动失败', error.message); app.quit();
  });
  app.on('window-all-closed', () => app.quit());
}
