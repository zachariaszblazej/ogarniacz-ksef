const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { run } = require('./matcher');
const { applyPlan } = require('./writer');

let last = null; // { ledgerPath, mtimeMs, plan }

// Wszystkie kopie zapasowe w jednym miejscu: %APPDATA%\<nazwa aplikacji>\backups
const backupsDir = () => path.join(app.getPath('userData'), 'backups');

ipcMain.handle('reset', () => { last = null; return true; });

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

// Zapisuje wybrane przez użytkownika zmiany z planu ostatniego dopasowania.
// Renderer przekazuje tylko {id, cells}; wartości zawsze pochodzą z planu w main.
ipcMain.handle('apply', async (_e, selection) => {
    try {
        if (!last) throw new Error('Najpierw uruchom dopasowanie.');
        if (fs.statSync(last.ledgerPath).mtimeMs !== last.mtimeMs) {
            throw new Error('Plik ewidencji zmienił się od czasu dopasowania. Uruchom „Dopasuj” ponownie.');
        }
        const seen = new Set();
        const filtered = [];
        for (const s of Array.isArray(selection) ? selection : []) {
            const item = Number.isInteger(s?.id) ? last.plan[s.id] : null;
            if (!item || seen.has(s.id) || !Array.isArray(s.cells)) continue;
            seen.add(s.id);
            const clone = { ...item };
            for (const c of ['b', 'c', 'f']) {
                clone[c] = { ...item[c], changed: item[c].changed && s.cells.includes(c) };
            }
            clone.hasChanges = clone.b.changed || clone.c.changed || clone.f.changed;
            if (clone.hasChanges) filtered.push(clone);
        }
        if (!filtered.length) throw new Error('Nie wybrano żadnych zmian do zapisania.');
        const r = await applyPlan(last.ledgerPath, filtered, backupsDir());
        last = null; // plan zużyty - wymagaj ponownego dopasowania
        return { ok: true, ...r };
    } catch (e) {
        const busy = ['EBUSY', 'EPERM', 'EACCES'].includes(e.code);
        return { ok: false, error: busy ? 'Nie można zapisać pliku – zamknij go w Excelu i spróbuj ponownie.' : e.message };
    }
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
