const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  scan: () => ipcRenderer.invoke('scan'),
  thumb: (id) => ipcRenderer.invoke('thumb', id),
  reveal: (id) => ipcRenderer.invoke('reveal', id),
  openExternal: (id) => ipcRenderer.invoke('open-external', id),
  trash: (id) => ipcRenderer.invoke('trash', id),
  favorite: (id, on) => ipcRenderer.invoke('favorite', id, on),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  fullscreen: (on) => ipcRenderer.invoke('fullscreen', on),
  onLibraryChanged: (cb) => ipcRenderer.on('library-changed', () => cb()),
  onFullscreen: (cb) => ipcRenderer.on('fullscreen', (_e, v) => cb(v)),
});
