'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const on = (channel) => (cb) => {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('launcher', {
  info: invoke('app:info'),
  getSettings: invoke('settings:get'),
  setSettings: invoke('settings:set'),
  loadRemote: invoke('remote:load'),
  serverStatus: invoke('server:status'),
  checkNick: invoke('nick:check'),
  play: invoke('game:play'),
  verify: invoke('game:verify'),
  cancel: invoke('game:cancel'),
  gameState: invoke('game:state'),
  getLogs: invoke('logs:get'),
  copyLogs: invoke('logs:copy'),
  openLogs: invoke('logs:open'),
  openGameDir: invoke('dir:open'),
  chooseGameDir: invoke('dir:choose'),
  minimize: invoke('window:minimize'),
  close: invoke('window:close'),
  onProgress: on('game:progress'),
  onSteps: on('game:steps'),
  onGameState: on('game:state'),
  onLog: on('log:line'),
});
