const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('printqsDesktop', {
  load: () => ipcRenderer.invoke('agent:load'),
  configure: (config) => ipcRenderer.invoke('agent:configure', config),
  restart: () => ipcRenderer.invoke('agent:restart'),
  openDashboard: () => ipcRenderer.invoke('agent:open-dashboard'),
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('agent:status', listener);
    return () => ipcRenderer.off('agent:status', listener);
  },
});
