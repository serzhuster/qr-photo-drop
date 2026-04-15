const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  on: (channel, callback) => {
    const allowed = ['files-received', 'session-created', 'session-reset'];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_event, data) => callback(data));
    }
  },
  selectFolder: () => ipcRenderer.invoke('select-folder')
});
