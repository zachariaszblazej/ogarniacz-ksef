const XLSX = require('xlsx');

const MONTHS = ['styczen', 'luty', 'marzec', 'kwiecien', 'maj', 'czerwiec',
    'lipiec', 'sierpien', 'wrzesien', 'pazdziernik', 'listopad', 'grudzien'];

function norm(text) {
    return String(text).toLowerCase().replace(/ł/g, 'l')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function plain(v) {
    return v === undefined ? null : v;
}

function toCents(v) {
    v = plain(v);
    if (v === null || typeof v === 'boolean' || v instanceof Date) return null;
    if (typeof v === 'number') return Math.round(v * 100);
    let s = String(v).replace(/\u00a0/g, '').replace(/[^\d,.\-]/g, '');
    if (!s) return null;
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    const n = parseFloat(s);
    return Number.isNaN(n) ? null : Math.round(n * 100);
}

function ksefMonth(nr) {
    const m = /-(\d{4})(\d{2})(\d{2})-/.exec(String(nr ?? ''));
    if (!m) return null;
    const mo = parseInt(m[2], 10);
    return mo >= 1 && mo <= 12 ? mo : null;
}

function fmtDate(v) {
    if (v instanceof Date) {
        const p = x => String(x).padStart(2, '0');
        return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
    }
    return v === null || v === undefined ? '' : String(v);
}

function openBook(path) {
    // sheetStubs: puste, ale sformatowane komórki też są widoczne (potrzebne do wykrywania wolnych wierszy)
    return XLSX.readFile(path, { cellDates: true, sheetStubs: true });
}

// Wartość komórki (wiersz i kolumna 1-based) lub null
function cell(ws, row, col) {
    const c = ws[XLSX.utils.encode_cell({ r: row - 1, c: col - 1 })];
    return plain(c ? c.v : null);
}

function lastRow(ws) {
    return ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']).e.r + 1 : 0;
}

async function readInvoices(path) {
    const wb = openBook(path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const out = [];
    for (let n = 2; n <= lastRow(ws); n++) {
        const cells = [1, 2, 3, 4, 5].map(c => cell(ws, n, c));
        if (cells.every(c => c === null || c === '')) continue;
        out.push({
            date: fmtDate(cells[0]), number: cells[1] ?? '', ksef: cells[2] ?? '',
            contractor: cells[3] ?? '', amount: cells[4] ?? '', cents: toCents(cells[4]),
        });
    }
    return out;
}

async function readLedger(path) {
    const wb = openBook(path);
    const ledger = {};
    for (const sheetName of wb.SheetNames) {
        const name = norm(sheetName);
        const idx = MONTHS.findIndex(m => name.includes(m));
        if (idx < 0) continue;
        const ws = wb.Sheets[sheetName];
        const data = {
            przychod: new Map(), koszt: new Map(),
            sheet: sheetName,
            freeRows: [],   // wolne, sformatowane wiersze na nowe operacje: { row, lp }
            cTexts: [],     // zawartość kolumny C (nr FV) - do wykrywania duplikatów
        };
        for (let n = 6; n <= lastRow(ws); n++) {
            const lp = cell(ws, n, 1);
            if (lp === null || lp === '') continue;
            const cVal = cell(ws, n, 3);
            if (cVal !== null && cVal !== '') data.cTexts.push(String(cVal));
            if (isFreeRow(ws, n)) data.freeRows.push({ row: n, lp });
            // operacja już oznaczona jako będąca w KSEF (B = T) i z numerem KSEF w "nr FV" - pomijamy przy dopasowaniu
            if (isKsefDone(cell(ws, n, 2), cVal)) continue;
            const firma = cell(ws, n, 5) ?? '';
            const uwagi = fmtNote(cell(ws, n, 26));
            const seen = new Set();
            // koszty: brutto (Q) oraz brutto paliwo (T)
            for (const [key, col] of [['przychod', 13], ['koszt', 17], ['koszt', 20]]) {
                const c = toCents(cell(ws, n, col));
                if (!c) continue;
                const k = Math.abs(c);
                if (seen.has(key + k)) continue; // ta sama kwota w Q i T tego samego wiersza - jedna pozycja
                seen.add(key + k);
                if (!data[key].has(k)) data[key].set(k, []);
                data[key].get(k).push({
                    lp, firma, uwagi, sheet: sheetName, row: n,
                    b: cell(ws, n, 2), c: cell(ws, n, 3), f: cell(ws, n, 6),
                });
            }
        }
        ledger[idx + 1] = data;
    }
    return ledger;
}

// Numer KSEF: 10 cyfr - 8 cyfr - 12 znaków [A-Z0-9] - 2 znaki [A-Z0-9] (35 znaków).
// Lookaround zamiast \b, żeby numer był rozpoznany także obok "_" (np. "FV 1_1234567890-...").
const KSEF_NUMBER_RE = /(?<![A-Za-z0-9])\d{10}-\d{8}-[A-Za-z0-9]{12}-[A-Za-z0-9]{2}(?![A-Za-z0-9])/;

function isKsefDone(b, c) {
    const bOk = b !== null && b !== undefined && String(b).trim().toUpperCase() === 'T';
    return bOk && KSEF_NUMBER_RE.test(String(c ?? ''));
}

// Kolumny wejściowe (ręcznie wypełniane) - wolny wiersz musi mieć je wszystkie puste
const INPUT_COLS = [2, 3, 4, 5, 6, 7, 8, 12, 15, 16, 20, 22, 23, 24, 26];
// Kolumny, do których zapisujemy - ich komórki muszą istnieć (być sformatowane) w wierszu
const WRITE_COLS = [2, 3, 5, 6, 12, 16];

function hasCell(ws, row, col) {
    return Boolean(ws[XLSX.utils.encode_cell({ r: row - 1, c: col - 1 })]);
}

function isFreeRow(ws, n) {
    if (!WRITE_COLS.every(c => hasCell(ws, n, c))) return false;
    return INPUT_COLS.every(c => {
        const v = cell(ws, n, c);
        return v === null || v === '';
    });
}

// Kwota brutto (w groszach) -> netto jako tekst "1234.56", bez arytmetyki zmiennoprzecinkowej na kwotach.
// Dzielenie całkowitoliczbowe: round(brutto * 100 / 123); remis (.5) jest niemożliwy, bo 123 jest nieparzyste.
function netString(cents) {
    const nc = Math.round(Math.abs(cents) * 100 / 123);
    return `${Math.floor(nc / 100)}.${String(nc % 100).padStart(2, '0')}`;
}

// Wartość komórki "Uwagi" (kol. Z) jako tekst do wyświetlenia
function fmtNote(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return fmtDate(v);
    return String(v).trim();
}

function firstWord(text) {
    return String(text ?? '').trim().split(/\s+/)[0] || '';
}

function ksefDateParts(nr) {
    const m = /-(\d{4})(\d{2})(\d{2})-/.exec(String(nr ?? ''));
    if (!m) return null;
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    const p = x => String(x).padStart(2, '0');
    return { text: `${p(d)}.${p(mo)}.${y}`, serial: Math.round(dt.getTime() / 86400000) + 25569 };
}

function displayDate(v) {
    if (v instanceof Date) {
        const p = x => String(x).padStart(2, '0');
        return `${p(v.getDate())}.${p(v.getMonth() + 1)}.${v.getFullYear()}`;
    }
    return v === null || v === undefined ? '' : String(v).trim();
}

// Plan zmian w ewidencji dla jednej zmatchowanej operacji
function makePlanItem(inv, e) {
    const ksef = String(inv.ksef).trim();
    const bOld = e.b === null ? '' : String(e.b).trim();
    const cOld = e.c === null ? '' : String(e.c).trim();
    const cNew = cOld === '' ? ksef : (cOld.includes(ksef) ? cOld : `${cOld}; ${ksef}`);
    const date = ksefDateParts(ksef);
    const fOld = displayDate(e.f);
    const fNew = date ? date.text : fOld;
    const item = {
        sheet: e.sheet, row: e.row, lp: e.lp, firma: e.firma, ksef,
        b: { old: bOld, new: 'T', changed: bOld !== 'T' },
        c: { old: cOld, new: cNew, changed: cNew !== cOld },
        f: {
            old: fOld, new: fNew, changed: fNew !== fOld,
            serial: date ? date.serial : null,
            asText: typeof e.f === 'string' && e.f.trim() !== '',
        },
    };
    item.hasChanges = item.b.changed || item.c.changed || item.f.changed;
    return item;
}

function match(invoices, ledger) {
    const counts = new Map();
    for (const i of invoices) if (i.cents !== null) counts.set(i.cents, (counts.get(i.cents) || 0) + 1);
    const matched = [], unmatched = [], plan = [], additions = [];
    const ledgerC = Object.values(ledger).flatMap(d => d.cTexts).join('\n');
    const free = {};
    for (const d of Object.values(ledger)) free[d.sheet] = d.freeRows;
    for (const inv of invoices) {
        let found = [];
        let reason = 'Inne';
        let noMatch = false;
        const month = ksefMonth(inv.ksef);
        if (inv.cents !== null && counts.get(inv.cents) > 1) {
            reason = 'Więcej niż 1 faktura od księgowej z tą samą kwotą brutto';
        } else if (inv.cents !== null && ledger[month]) {
            const key = inv.cents < 0 ? 'przychod' : 'koszt';
            found = ledger[month][key].get(Math.abs(inv.cents)) || [];
            if (found.length === 0) { reason = 'Brak operacji finansowej dla tej faktury (brak matchy)'; noMatch = true; }
            else if (found.length > 1) reason = 'Więcej niż 1 pasująca operacja finansowa (więcej niż 1 match)';
        }
        if (found.length === 1) {
            plan.push(makePlanItem(inv, found[0]));
            matched.push({
                lp: found[0].lp, amount: (inv.cents / 100).toFixed(2),
                ksef: inv.ksef, contractor: inv.contractor, firma: found[0].firma, uwagi: found[0].uwagi,
            });
        } else {
            const rec = {
                date: inv.date, number: inv.number, ksef: inv.ksef, contractor: inv.contractor,
                amount: inv.cents === null ? String(inv.amount) : (inv.cents / 100).toFixed(2),
                reason,
            };
            if (noMatch) {
                const ksef = String(inv.ksef).trim();
                if (ksef && ledgerC.includes(ksef)) {
                    rec.alreadyIn = true; // ta faktura została już wcześniej dopisana do ewidencji
                } else {
                    const date = ksefDateParts(ksef);
                    rec.addId = additions.length;
                    additions.push({
                        sheet: ledger[month].sheet, ksef, number: String(inv.number).trim(),
                        b: 'T',
                        c: `${String(inv.number).trim()}; ${ksef}`,
                        e: firstWord(inv.contractor),
                        f: date ? { text: date.text, serial: date.serial } : null,
                        amountCol: inv.cents > 0 ? 'P' : 'L', // koszt netto : przychód netto
                        amount: netString(inv.cents),
                    });
                }
            }
            unmatched.push(rec);
        }
    }
    return { matched, unmatched, plan, additions, free };
}

async function run(invoicesPath, ledgerPath) {
    const invoices = await readInvoices(invoicesPath);
    const ledger = await readLedger(ledgerPath);
    const months = Object.keys(ledger).map(Number).sort((a, b) => a - b);
    return { ...match(invoices, ledger), total: invoices.length, months };
}

module.exports = { run, ksefMonth, toCents, match, netString };
