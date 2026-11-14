const XLSX = require('xlsx');
const { readAmounts, readDueDate, readPaidDate } = require('./xmlInvoice');
const { pdfPath } = require('./pdfInvoice');

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
            date: fmtDate(cells[0]), dateParts: dateParts(cells[0]), number: cells[1] ?? '', ksef: cells[2] ?? '',
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
            koszt: new Map(), // klucz: kwota brutto ze znakiem (korekty mają minus)
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
            const zl = fmtNote(cell(ws, n, 4));
            const seen = new Set();
            // tylko koszty: brutto (Q), brutto paliwo (T) oraz "Inni robią zakupy" = netto (X) + VAT (Y) - nie ma kolumny brutto
            const cols = [['koszt', 17], ['koszt', 20]];
            const inni = (toCents(cell(ws, n, 24)) || 0) + (toCents(cell(ws, n, 25)) || 0);
            for (const [key, col] of cols.concat(inni ? [['koszt', 'inni']] : [])) {
                const c = col === 'inni' ? inni : toCents(cell(ws, n, col));
                if (!c) continue;
                const k = c; // ze znakiem
                if (seen.has(key + k)) continue; // ta sama kwota w Q i T tego samego wiersza - jedna pozycja
                seen.add(key + k);
                if (!data[key].has(k)) data[key].set(k, []);
                data[key].get(k).push({
                    lp, firma, uwagi, zl, sheet: sheetName, row: n, gross: k, // brutto z ewidencji (Q, T albo X+Y), w groszach
                    b: cell(ws, n, 2), c: cell(ws, n, 3), f: cell(ws, n, 6),
                    g: cell(ws, n, 7), h: cell(ws, n, 8), gHas: hasCell(ws, n, 7), hHas: hasCell(ws, n, 8),
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
const INPUT_COLS = Array.from({ length: 25 }, (_, i) => i + 2); // B..Z
// Kolumny, do których zapisujemy - ich komórki muszą istnieć (być sformatowane) w wierszu
const WRITE_COLS = [2, 3, 4, 5, 6, 7, 8, 12, 16, 26];

function hasCell(ws, row, col) {
    return Boolean(ws[XLSX.utils.encode_cell({ r: row - 1, c: col - 1 })]);
}

// Wolny wiersz: kolumny B..Z bez wpisanych wartości. Formuły z odwołaniami/funkcjami nie liczą się.
function isFreeRow(ws, n) {
    if (!WRITE_COLS.every(c => hasCell(ws, n, c))) return false;
    return INPUT_COLS.every(c => {
        const raw = ws[XLSX.utils.encode_cell({ r: n - 1, c: c - 1 })];
        // formuły (np. =IF(...), =L6*1.23) nie liczą się; wyjątkiem są stałe wyrażenia typu =16.99/1.23 - to wpisana kwota
        if (raw && raw.f !== undefined && !/^[\d\s.,+\-*/()]+$/.test(String(raw.f))) return true;
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

// Kwota w groszach (może być ujemna) -> tekst "1234.56" / "-1234.56"
function centsString(c) {
    const a = Math.abs(c);
    return `${c < 0 ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

// Wartość komórki "Uwagi" (kol. Z) jako tekst do wyświetlenia
function fmtNote(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return fmtDate(v);
    return String(v).trim();
}

// Nazwa firmy do kolumny E: bez znaków specjalnych na początku; człony są dodawane, aż wynik osiągnie 20 znaków
// - człon, na którym limit zostaje osiągnięty lub przekroczony, jest brany w całości.
const COMPANY_MAX = 20;
function firstWord(text) {
    const words = String(text ?? '').replace(/^[^\p{L}\p{N}]+/u, '').split(/\s+/).filter(Boolean);
    let out = '';
    for (const w of words) {
        if (out.length >= COMPANY_MAX) break;
        out = out ? out + ' ' + w : w;
    }
    return out;
}

// Data (rok, miesiąc, dzień) -> { text: DD.MM.RRRR, month, serial: numer dnia Excela } albo null, gdy to nie jest poprawna data
function ymdParts(y, mo, d) {
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    const p = x => String(x).padStart(2, '0');
    return { text: `${p(d)}.${p(mo)}.${y}`, month: mo, serial: Math.round(dt.getTime() / 86400000) + 25569 };
}

// Data wystawienia z kolumny A listy księgowej: Date, numer seryjny Excela albo tekst RRRR-MM-DD / DD.MM.RRRR
function dateParts(v) {
    if (v instanceof Date) return ymdParts(v.getFullYear(), v.getMonth() + 1, v.getDate());
    if (typeof v === 'number') {
        const c = XLSX.SSF.parse_date_code(v);
        return c ? ymdParts(c.y, c.m, c.d) : null;
    }
    const s = String(v ?? '').trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return ymdParts(+m[1], +m[2], +m[3]);
    m = /^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/.exec(s);
    return m ? ymdParts(+m[3], +m[2], +m[1]) : null;
}

function displayDate(v) {
    if (v instanceof Date) {
        const p = x => String(x).padStart(2, '0');
        return `${p(v.getDate())}.${p(v.getMonth() + 1)}.${v.getFullYear()}`;
    }
    return v === null || v === undefined ? '' : String(v).trim();
}

// Data z XML do kolumny G/H istniejącej operacji; nigdy nie nadpisuje wartości już wpisanej w ewidencji.
// status: 'none' (brak daty w XML lub brak komórki), 'new' (wpisujemy), 'same' (już jest), 'diff' (już jest, ale inna)
function dateCell(oldVal, hasCellInSheet, proposed) {
    const old = displayDate(oldVal);
    if (!proposed) return { old, new: old, changed: false, serial: null, status: 'none' };
    if (old !== '') {
        const cur = dateParts(oldVal);
        const same = Boolean(cur) && cur.text === proposed.text;
        // diff: wartość z faktury zostaje jako alternatywa, którą użytkownik może wybrać zamiast tej z ewidencji
        const alt = same ? undefined : {
            text: proposed.text, serial: proposed.serial, auto: Boolean(proposed.auto),
            asText: typeof oldVal === 'string' && oldVal.trim() !== '',
        };
        return { old, new: old, changed: false, serial: null, status: same ? 'same' : 'diff', alt };
    }
    if (!hasCellInSheet) return { old, new: old, changed: false, serial: null, status: 'none' };
    return { old, new: proposed.text, changed: true, serial: proposed.serial, status: 'new', auto: Boolean(proposed.auto) };
}

// Plan zmian w ewidencji dla jednej zmatchowanej operacji
// dates: { g, h } - daty z XML ({ text, serial, auto? } albo null)
function makePlanItem(inv, e, dates) {
    const ksef = String(inv.ksef).trim();
    const bOld = e.b === null ? '' : String(e.b).trim();
    const cOld = e.c === null ? '' : String(e.c).trim();
    // kolumna C: pusta -> sam nr KSEF; w przeciwnym razie dopisujemy "; nr KSEF"
    const cNew = cOld === '' ? ksef : (cOld.includes(ksef) ? cOld : `${cOld}; ${ksef}`);
    const date = inv.dateParts;
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
        g: dateCell(e.g, e.gHas, dates.g),
        h: dateCell(e.h, e.hHas, dates.h),
    };
    item.paidBoth = Boolean(dates.h) && item.g.old !== '' && item.h.old !== ''; // opłacona w XML i G, H wypełnione w ewidencji
    item.hasChanges = item.b.changed || item.c.changed || item.f.changed || item.g.changed || item.h.changed;
    return item;
}

// Rekord faktury w tabeli dopasowanych (kwota brutto pochodzi z ewidencji)
function makeMatchedRecord(inv, e) {
    return {
        lp: e.lp, amount: (e.gross / 100).toFixed(2), date: inv.date,
        ksef: inv.ksef, contractor: inv.contractor, firma: e.firma, uwagi: e.uwagi,
    };
}

function match(invoices, ledger, amountsFor, dueFor, paidFor) {
    const ledgerC = Object.values(ledger).flatMap(d => d.cTexts).join('\n');
    // faktura jest już w ewidencji, gdy jej numer KSEF występuje w kolumnie "nr FV"
    const isAlready = inv => { const k = String(inv.ksef ?? '').trim(); return k !== '' && ledgerC.includes(k); };
    // faktury już w ewidencji nie liczą się do wykrywania duplikatów kwoty
    const counts = new Map();
    for (const i of invoices) {
        if (i.cents !== null && !isAlready(i)) counts.set(i.cents, (counts.get(i.cents) || 0) + 1);
    }
    const matched = [], unmatched = [], already = [], plan = [], additions = [];
    const unmatchedMeta = []; // { rec, month, cents, inv, gDate, paid } - do wyznaczania kandydatów i dopisania jako nowa
    const manual = []; // dane do ręcznego dopasowania faktur (tylko dla procesu głównego)

    // Kandydaci do ręcznego dopasowania: nieksefowe operacje z miesiąca faktury o tej samej kwocie brutto oraz różniące się
    // o ±1 grosz (różne metody liczenia netto/VAT/brutto). Dostępność (czy operacja jest już zajęta) rozstrzyga interfejs.
    const candidates = (month, cents) => {
        const entries = new Map();
        const exact = new Set();
        if (cents === null || !ledger[month]) return { entries, exact };
        for (const delta of [0, -1, 1]) {
            for (const e of ledger[month].koszt.get(cents + delta) || []) {
                const key = e.sheet + ':' + e.row;
                entries.set(key, e);
                if (delta === 0) exact.add(key);
            }
        }
        return { entries, exact };
    };
    const candidateList = ({ entries, exact }) => [...entries.entries()].map(([key, e]) => ({
        key, lp: e.lp, zl: e.zl, firma: String(e.firma ?? '').trim(), gross: e.gross, uwagi: e.uwagi, exact: exact.has(key),
    })).sort((a, b) => String(a.lp).localeCompare(String(b.lp), 'pl', { numeric: true }));

    // Operacja do dopisania w nowym wierszu ewidencji; kwoty netto i VAT wyłącznie z pliku XML faktury (bez XML: puste)
    const buildAddition = (inv, sheet, gDate, paid) => {
        const ksef = String(inv.ksef).trim();
        const date = inv.dateParts;
        const grossC = inv.cents; // ze znakiem
        const xml = amountsFor ? amountsFor(ksef) : { error: 'nie podano folderu z XML' };
        let netC = null, vatC = null, verify;
        if (xml.error) {
            verify = { ok: false, text: `brak kwot netto i VAT: ${xml.error}` };
        } else {
            netC = xml.net;
            vatC = xml.vat;
            verify = netC + vatC === grossC
                ? { ok: true, text: '' }
                : { ok: false, text: `kwota brutto: ${centsString(grossC).replace('.', ',')}, suma netto i VAT: ${centsString(netC + vatC).replace('.', ',')}` };
        }
        return {
            sheet, ksef,
            b: 'T',
            c: ksef,
            e: firstWord(inv.contractor),
            f: date ? { text: date.text, serial: date.serial } : null,
            // brak terminu zapłaty, ale faktura opłacona: do G trafia data faktycznej zapłaty (auto)
            g: gDate,
            h: paid ? { text: paid.text, serial: paid.serial } : null,
            amountCol: 'P', // koszty netto
            amount: netC === null ? null : centsString(netC),
            gross: centsString(grossC),
            vat: vatC === null ? null : centsString(vatC),
            verify,
            grossCol: 'Q',
            vatCol: 'R',
            cost: true,
        };
    };
    const free = {};
    for (const d of Object.values(ledger)) free[d.sheet] = d.freeRows;
    for (const inv of invoices) {
        if (isAlready(inv)) {
            already.push({
                date: inv.date, ksef: inv.ksef, contractor: inv.contractor,
                amount: inv.cents === null ? String(inv.amount) : (inv.cents / 100).toFixed(2),
            });
            continue;
        }
        const due = dueFor ? dueFor(inv.ksef) : null; // termin płatności z XML: { text, serial } albo null
        const paid = paidFor ? paidFor(inv.ksef) : null; // faktyczna data zapłaty z XML (tylko gdy Zaplacono = 1)
        // brak terminu zapłaty, ale faktura opłacona: do G trafia data faktycznej zapłaty (auto)
        const gDate = due || (paid ? { text: paid.text, serial: paid.serial, auto: true } : null);
        let found = [];
        let reason = 'Inne';
        let noMatch = false;
        const month = inv.dateParts ? inv.dateParts.month : null;
        const multi = inv.cents !== null && counts.get(inv.cents) > 1; // kilka faktur od księgowej na tę samą kwotę
        // wszystkie faktury to koszty; ujemne brutto (korekty) szukamy ze znakiem minus
        const ops = inv.cents !== null && ledger[month] ? (ledger[month].koszt.get(inv.cents) || []) : [];
        if (multi) {
            const amt = (inv.cents / 100).toFixed(2).replace('.', ','); // z przecinkiem dziesiętnym
            if (ops.length) {
                reason = `Wiele faktur i wiele operacji na kwotę ${amt}`;
            } else {
                reason = `Wiele faktur, ale brak operacji na kwotę ${amt}`;
                noMatch = Boolean(ledger[month]); // dopisujemy jako nowe operacje (wymaga arkusza miesiąca)
            }
        } else if (inv.cents !== null && ledger[month]) {
            found = ops;
            if (found.length === 0) { reason = 'Brak dopasowania'; noMatch = true; }
            else if (found.length > 1) reason = 'Wiele dopasowań';
        }
        if (found.length === 1) {
            plan.push(makePlanItem(inv, found[0], { g: gDate, h: paid }));
            const mrec = makeMatchedRecord(inv, found[0]);
            // dane potrzebne, gdy użytkownik odrzuci dopasowanie (lista operacji, dopisanie jako nowa operacja)
            const cand = candidates(month, inv.cents);
            mrec.opKey = found[0].sheet + ':' + found[0].row;
            mrec.nearId = manual.length;
            manual.push({ inv, gDate, paid, entries: cand.entries });
            mrec.nearOps = candidateList(cand);
            mrec.hasExact = cand.exact.size > 0;
            mrec.due = due ? due.text : '';
            mrec.paid = paid ? paid.text : '';
            mrec.shortName = firstWord(inv.contractor);
            mrec.latentAddId = additions.length;
            additions.push({ ...buildAddition(inv, ledger[month].sheet, gDate, paid), latent: true });
            matched.push(mrec);
        } else {
            const rec = {
                date: inv.date, ksef: inv.ksef, contractor: firstWord(inv.contractor),
                due: due ? due.text : '',
                paid: paid ? paid.text : '',
                amount: inv.cents === null ? String(inv.amount) : (inv.cents / 100).toFixed(2),
                reason,
            };
            if (noMatch) {
                rec.addId = additions.length;
                additions.push(buildAddition(inv, ledger[month].sheet, gDate, paid));
                rec.canFuel = true;
                rec.canInni = true;
            }
            unmatched.push(rec);
            unmatchedMeta.push({ rec, month, cents: inv.cents, inv, gDate, paid });
        }
    }
    // Kandydaci do ręcznego dopasowania niedopasowanych faktur (ta sama kwota brutto lub ±1 grosz)
    for (const { rec, month, cents, inv, gDate, paid } of unmatchedMeta) {
        const cand = candidates(month, cents);
        if (cand.entries.size) {
            rec.nearOps = candidateList(cand);
            rec.hasExact = cand.exact.size > 0;
            rec.nearId = manual.length;
            manual.push({ inv, gDate, paid, entries: cand.entries }); // entries: Map klucz -> wpis ewidencji
        }
        // wiele pasujących operacji: fakturę można też dopisać jako nową - operacja czeka wyłączona (latent)
        if (rec.hasExact && rec.addId === undefined) {
            rec.latentAddId = additions.length;
            additions.push({ ...buildAddition(inv, ledger[month].sheet, gDate, paid), latent: true });
        }
    }
    return { matched, unmatched, already, plan, additions, free, manual };
}

async function run(invoicesPath, ledgerPath, xmlDir, pdfDir) {
    const invoices = await readInvoices(invoicesPath);
    const ledger = await readLedger(ledgerPath);
    const months = Object.keys(ledger).map(Number).sort((a, b) => a - b);
    const result = match(invoices, ledger, ksef => readAmounts(xmlDir, ksef), ksef => dateParts(readDueDate(xmlDir, ksef)), ksef => dateParts(readPaidDate(xmlDir, ksef)));
    for (const list of [result.matched, result.unmatched, result.already, result.plan, result.additions]) {
        for (const r of list) r.pdf = pdfPath(pdfDir, r.ksef) !== null;
    }
    return { ...result, total: invoices.length, months };
}

module.exports = { run, toCents, match, netString, makePlanItem, makeMatchedRecord };
