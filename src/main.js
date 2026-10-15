const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { run } = require('./matcher');
const { applyPlan } = require('./writer');

let last = null; // { ledgerPath, mtimeMs, plan }

// Wszystkie kopie zapasowe w jednym miejscu: %APPDATA%\<nazwa aplikacji>\backups
const backupsDir = () => path.join(app.getPath('userData'), 'backups');

ipcMain.handle('open-backups', async () => {
    fs.mkdirSync(backupsDir(), { recursive: true });
    await shell.openPath(backupsDir());
    return backupsDir();
});

function createWindow() {
    const win = new BrowserWindow({
        width: 1200, height: 820, minWidth: 900, minHeight: 600,
        title: 'Ogarniacz KSEF', backgroundColor: '#1a1b1e',
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
        const mtimeMs = fs.statSync(ledgerPath).mtimeMs;
        const result = await run(invoicesPath, ledgerPath);
        last = { ledgerPath, mtimeMs, plan: result.plan };
        return { ok: true, result };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// Zapisuje plan z ostatniego dopasowania (nie ufa danym z renderera)
ipcMain.handle('apply', async () => {
    try {
        if (!last) throw new Error('Najpierw uruchom dopasowanie.');
        if (fs.statSync(last.ledgerPath).mtimeMs !== last.mtimeMs) {
            throw new Error('Plik ewidencji zmienił się od czasu dopasowania. Uruchom „Dopasuj” ponownie.');
        }
        const r = await applyPlan(last.ledgerPath, last.plan, backupsDir());
        last = null; // plan zużyty - wymagaj ponownego dopasowania
        return { ok: true, ...r };
    } catch (e) {
        const busy = ['EBUSY', 'EPERM', 'EACCES'].includes(e.code);
        return { ok: false, error: busy ? 'Nie można zapisać pliku – zamknij go w Excelu i spróbuj ponownie.' : e.message };
    }
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
