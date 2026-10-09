const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studio', {
  api: (method, route, body) => ipcRenderer.invoke('studio:api', method, route, body),
  importAsset: stage => ipcRenderer.invoke('studio:import', stage),
  importPaths: (stage, paths) => ipcRenderer.invoke('studio:importPaths', stage, paths),
  filePath: file => require('electron').webUtils.getPathForFile(file),
  openProject: () => ipcRenderer.invoke('studio:openProject'),
  saveAsset: (stage, id) => ipcRenderer.invoke('studio:saveAsset', stage, id),
  showAsset: (stage, id) => ipcRenderer.invoke('studio:showAsset', stage, id),
  metadata: id => ipcRenderer.invoke('studio:metadata', id),
  help: () => ipcRenderer.invoke('studio:help'),
  kimiStatus: () => ipcRenderer.invoke('kimi:status'),
  kimiCatalog: () => ipcRenderer.invoke('kimi:catalog'),
  kimiSetSelection: selection => ipcRenderer.invoke('kimi:selection', selection),
  providerAction: (action, payload) => ipcRenderer.invoke('kimi:providers', action, payload),
  kimiStart: request => ipcRenderer.invoke('kimi:start', request),
  kimiCancel: () => ipcRenderer.invoke('kimi:cancel'),
  kimiTerminal: () => ipcRenderer.invoke('kimi:terminal'),
  copyText: text => ipcRenderer.invoke('studio:copyText', text),
  consoleState: () => ipcRenderer.invoke('console:state'),
  consoleClear: () => ipcRenderer.invoke('console:clear'),
  onConsole: callback => {
    const handler = (_event, packet) => callback(packet);
    ipcRenderer.on('console:event', handler);
    return () => ipcRenderer.removeListener('console:event', handler);
  },
  flushComplete: () => ipcRenderer.invoke('studio:flushComplete'),
  onBeforeClose: callback => {
    const handler = () => callback();
    ipcRenderer.on('studio:flush', handler);
    return () => ipcRenderer.removeListener('studio:flush', handler);
  },
  onKimi: callback => {
    const handler = (_event, packet) => callback(packet);
    ipcRenderer.on('kimi:event', handler);
    return () => ipcRenderer.removeListener('kimi:event', handler);
  },
});
