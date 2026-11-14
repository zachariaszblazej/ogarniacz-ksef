const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    pickFile: title => ipcRenderer.invoke('pick-file', title),
    pickDir: title => ipcRenderer.invoke('pick-dir', title),
    pickBundle: title => ipcRenderer.invoke('pick-bundle', title),
    match: (inv, led, xml, pdf) => ipcRenderer.invoke('match', inv, led, xml, pdf),
    openPdf: ksef => ipcRenderer.invoke('open-pdf', ksef),
    apply: selection => ipcRenderer.invoke('apply', selection),
    openBackups: () => ipcRenderer.invoke('open-backups'),
    reset: () => ipcRenderer.invoke('reset'),
    version: () => ipcRenderer.invoke('version'),
});
