const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    pickFile: title => ipcRenderer.invoke('pick-file', title),
    match: (inv, led) => ipcRenderer.invoke('match', inv, led),
    apply: selection => ipcRenderer.invoke('apply', selection),
    openBackups: () => ipcRenderer.invoke('open-backups'),
});
