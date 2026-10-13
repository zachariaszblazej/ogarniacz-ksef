const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const { run } = require('./matcher');

function createWindow() {
  const win = new BrowserWindow({
    width: 1200, height: 820, minWidth: 900, minHeight: 600,
    title: 'Ogarniacz KSEF', backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('pick-file', async (_e, title) => {
  const r = await dialog.showOpenDialog({
    title, properties: ['openFile'],
    filters: [{ name: 'Excel', extensions: ['xlsx', 'xlsm'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('match', async (_e, invoicesPath, ledgerPath) => {
  try {
    return { ok: true, result: await run(invoicesPath, ledgerPath) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
