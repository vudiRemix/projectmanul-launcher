'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('splash', {
  onState: (cb) => ipcRenderer.on('splash:state', (_e, state) => cb(state)),
});
