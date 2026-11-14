const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { run } = require('./matcher');
const { applyPlan } = require('./writer');
const { pdfPath } = require('./pdfInvoice');
const { scanBundle } = require('./bundle');

let last = null; // { ledgerPath, mtimeMs, plan }
let pdfDir = null; // folder z PDF-ami z ostatniego dopasowania

// Wszystkie kopie zapasowe w jednym miejscu: %APPDATA%\<nazwa aplikacji>\backups
const backupsDir = () => path.join(app.getPath('userData'), 'backups');

ipcMain.handle('reset', () => { last = null; return true; });
ipcMain.handle('version', () => app.getVersion());

ipcMain.handle('open-backups', async () => {
    fs.mkdirSync(backupsDir(), { recursive: true });
    await shell.openPath(backupsDir());
    return backupsDir();
});

let mainWindow = null;
let helpWindow = null;

// Dokumentacja pomocnicza w osobnym oknie (jedno naraz)
ipcMain.handle('open-help', () => {
    if (helpWindow) {
        if (helpWindow.isMinimized()) helpWindow.restore();
        helpWindow.focus();
        return;
    }
    helpWindow = new BrowserWindow({
        width: 980, height: 820, minWidth: 600, minHeight: 400,
        title: 'Ogarniacz KSEF – pomoc', backgroundColor: '#1a1b1e',
        autoHideMenuBar: true,
        webPreferences: { contextIsolation: true },
    });
    helpWindow.on('closed', () => { helpWindow = null; });
    helpWindow.loadFile(path.join(__dirname, 'renderer', 'help.html'));
});

function createWindow() {
    const win = new BrowserWindow({
        width: 1200, height: 820, minWidth: 900, minHeight: 600,
        title: 'Ogarniacz KSEF', backgroundColor: '#1a1b1e',
        autoHideMenuBar: true,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
    });
    mainWindow = win;
    win.on('closed', () => {
        mainWindow = null;
        if (helpWindow) helpWindow.close(); // pomoc nie zostaje sama po zamknięciu programu
    });
    win.maximize();
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('pick-file', async (_e, title) => {
    const r = await dialog.showOpenDialog({
        title, properties: ['openFile'],
        filters: [{ name: 'Excel', extensions: ['xlsx', 'xlsm'] }],
    });
    return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('pick-dir', async (_e, title) => {
    const r = await dialog.showOpenDialog({ title, properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
});

// Jeden folder z listą (ZAKUP), folderem XML i folderem PDF w środku
ipcMain.handle('pick-bundle', async (_e, title) => {
    const r = await dialog.showOpenDialog({ title, properties: ['openDirectory'] });
    return r.canceled ? null : scanBundle(r.filePaths[0]);
});

// Renderer podaje tylko nr KSEF; ścieżka powstaje w main z zapamiętanego folderu.
ipcMain.handle('open-pdf', async (_e, ksef) => {
    const file = pdfPath(pdfDir, ksef);
    if (!file) return { ok: false, error: 'Nie znaleziono pliku PDF dla tej faktury.' };
    const err = await shell.openPath(file);
    return err ? { ok: false, error: err } : { ok: true };
});

ipcMain.handle('match', async (_e, invoicesPath, ledgerPath, xmlDir, pdfFolder) => {
    try {
        const mtimeMs = fs.statSync(ledgerPath).mtimeMs;
        const result = await run(invoicesPath, ledgerPath, xmlDir, pdfFolder);
        pdfDir = pdfFolder;
        last = { ledgerPath, mtimeMs, plan: result.plan, additions: result.additions, free: result.free };
        return { ok: true, result };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

const ADD_CELLS = ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'net', 'gross', 'vat', 'z'];

// Przypisuje wybrane nowe operacje do kolejnych wolnych wierszy (osobno dla każdego arkusza).
// To samo robi renderer na potrzeby podglądu - tu jest wersja rozstrzygająca.
function assignFreeRows(selected, free) {
    const pools = new Map();
    const out = [];
    for (const a of selected) {
        if (!pools.has(a.sheet)) pools.set(a.sheet, [...(free[a.sheet] || [])]);
        const slot = pools.get(a.sheet).shift();
        if (!slot) throw new Error(`Brak wolnych wierszy w arkuszu „${a.sheet}”. Nie można dopisać wszystkich wybranych operacji.`);
        out.push({ ...a, row: slot.row });
    }
    return out;
}

// Zapisuje wybrane przez użytkownika zmiany z planu ostatniego dopasowania.
// Renderer przekazuje tylko {id, cells}; wartości zawsze pochodzą z planu w main.
// selection = { changes: [{id, cells}], adds: [{id, cells}] }
ipcMain.handle('apply', async (_e, selection) => {
    try {
        if (!last) throw new Error('Najpierw uruchom dopasowanie.');
        if (fs.statSync(last.ledgerPath).mtimeMs !== last.mtimeMs) {
            throw new Error('Plik ewidencji zmienił się od czasu dopasowania. Uruchom „Dopasuj” ponownie.');
        }
        const seen = new Set();
        const filtered = [];
        for (const s of Array.isArray(selection?.changes) ? selection.changes : []) {
            const item = Number.isInteger(s?.id) ? last.plan[s.id] : null;
            if (!item || seen.has(s.id) || !Array.isArray(s.cells)) continue;
            seen.add(s.id);
            const clone = { ...item };
            for (const c of ['b', 'c', 'f', 'g', 'h']) {
                const over = (c === 'g' || c === 'h') && Array.isArray(s.over) && s.over.includes(c) && s.cells.includes(c);
                if (over && item[c].status === 'diff' && item[c].alt) {
                    // użytkownik wybrał wartość z faktury zamiast istniejącej w ewidencji
                    const alt = item[c].alt;
                    clone[c] = { ...item[c], changed: true, new: alt.text, serial: alt.serial, asText: alt.asText };
                } else {
                    clone[c] = { ...item[c], changed: item[c].changed && s.cells.includes(c) };
                }
            }
            clone.hasChanges = ['b', 'c', 'f', 'g', 'h'].some(c => clone[c].changed);
            if (clone.hasChanges) filtered.push(clone);
        }

        const seenAdd = new Set();
        const selectedAdds = [];
        for (const s of Array.isArray(selection?.adds) ? selection.adds : []) {
            const item = Number.isInteger(s?.id) ? last.additions[s.id] : null;
            if (!item || seenAdd.has(s.id) || !Array.isArray(s.cells)) continue;
            seenAdd.add(s.id);
            const fuel = s.fuel === true && item.cost;
            const inni = s.kind === 'inni' && item.cost;
            // teksty od użytkownika (nazwa firmy, ZL, uwagi) - tylko string, przycięty do rozsądnej długości
            const text = v => (typeof v === 'string' ? v.trim().slice(0, 255) : '');
            const zl = text(s.zl);
            const uwagi = text(s.uwagi);
            const cells = ADD_CELLS.filter(c => s.cells.includes(c) && !(inni && c === 'gross') &&
                !(c === 'g' && !item.g) && !(c === 'h' && !item.h) && !(c === 'd' && !zl) && !(c === 'z' && !uwagi) &&
                !(c === 'net' && item.amount === null) && !(c === 'vat' && item.vat === null));
            // paliwo: te same kwoty (netto, brutto, VAT) w kolumnach S, T, U;
            // inni: tylko netto i VAT w kolumnach X, Y (nie ma kolumny brutto)
            const entry = { id: s.id, ...item, cells, d: zl, z: uwagi };
            if (text(s.e)) entry.e = text(s.e);
            if (s.kind === 'fuel' && item.cost) Object.assign(entry, { amountCol: 'S', grossCol: 'T', vatCol: 'U' });
            if (inni) Object.assign(entry, { amountCol: 'X', grossCol: null, vatCol: 'Y' });
            if (cells.length) selectedAdds.push(entry);
        }
        selectedAdds.sort((a, b) => a.id - b.id);
        const adds = assignFreeRows(selectedAdds, last.free);

        if (!filtered.length && !adds.length) throw new Error('Nie wybrano żadnych zmian do zapisania.');
        const r = await applyPlan(last.ledgerPath, filtered, backupsDir(), adds);
        last = null; // plan zużyty - wymagaj ponownego dopasowania
        return { ok: true, ...r };
    } catch (e) {
        const busy = ['EBUSY', 'EPERM', 'EACCES'].includes(e.code);
        return { ok: false, error: busy ? 'Nie można zapisać pliku – zamknij go w Excelu i spróbuj ponownie.' : e.message };
    }
});

// Tylko jedno okno programu: drugie uruchomienie kończy się od razu, a istniejące okno wraca na wierzch
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    });
    app.whenReady().then(createWindow);
}
app.on('window-all-closed', () => app.quit());
