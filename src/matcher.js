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
  return XLSX.readFile(path, { cellDates: true });
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
    const data = { przychod: new Map(), koszt: new Map() };
    for (let n = 6; n <= lastRow(ws); n++) {
      const lp = cell(ws, n, 1);
      if (lp === null || lp === '') continue;
      const firma = cell(ws, n, 5) ?? '';
      for (const [key, col] of [['przychod', 13], ['koszt', 17]]) {
        const c = toCents(cell(ws, n, col));
        if (!c) continue;
        const k = Math.abs(c);
        if (!data[key].has(k)) data[key].set(k, []);
        data[key].get(k).push({ lp, firma });
      }
    }
    ledger[idx + 1] = data;
  }
  return ledger;
}

function match(invoices, ledger) {
  const counts = new Map();
  for (const i of invoices) if (i.cents !== null) counts.set(i.cents, (counts.get(i.cents) || 0) + 1);
  const matched = [], unmatched = [];
  for (const inv of invoices) {
    let found = [];
    const month = ksefMonth(inv.ksef);
    if (inv.cents !== null && counts.get(inv.cents) === 1 && ledger[month]) {
      const key = inv.cents < 0 ? 'przychod' : 'koszt';
      found = ledger[month][key].get(Math.abs(inv.cents)) || [];
    }
    if (found.length === 1) {
      matched.push({
        lp: found[0].lp, amount: (inv.cents / 100).toFixed(2),
        ksef: inv.ksef, contractor: inv.contractor, firma: found[0].firma,
      });
    } else {
      unmatched.push({
        date: inv.date, number: inv.number, ksef: inv.ksef, contractor: inv.contractor,
        amount: inv.cents === null ? String(inv.amount) : (inv.cents / 100).toFixed(2),
      });
    }
  }
  return { matched, unmatched };
}

async function run(invoicesPath, ledgerPath) {
  const invoices = await readInvoices(invoicesPath);
  const ledger = await readLedger(ledgerPath);
  const months = Object.keys(ledger).map(Number).sort((a, b) => a - b);
  return { ...match(invoices, ledger), total: invoices.length, months };
}

module.exports = { run, ksefMonth, toCents, match };
