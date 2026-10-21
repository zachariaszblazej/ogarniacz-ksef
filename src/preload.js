const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    pickFile: title => ipcRenderer.invoke('pick-file', title),
    pickDir: title => ipcRenderer.invoke('pick-dir', title),
    match: (inv, led, xml) => ipcRenderer.invoke('match', inv, led, xml),
    apply: selection => ipcRenderer.invoke('apply', selection),
    openBackups: () => ipcRenderer.invoke('open-backups'),
    reset: () => ipcRenderer.invoke('reset'),
});
