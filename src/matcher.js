const ExcelJS = require('exceljs');

const MONTHS = ['styczen', 'luty', 'marzec', 'kwiecien', 'maj', 'czerwiec',
  'lipiec', 'sierpien', 'wrzesien', 'pazdziernik', 'listopad', 'grudzien'];

function norm(text) {
  return String(text).toLowerCase().replace(/ł/g, 'l')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Wartość komórki -> prosta wartość (obsługa formuł, rich text, hiperłączy)
function plain(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('result' in v) return plain(v.result);
    if (v.richText) return v.richText.map(r => r.text).join('');
    if ('text' in v) return plain(v.text);
    return null;
  }
  return v;
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
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return v === null || v === undefined ? '' : String(v);
}

async function readInvoices(path) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.worksheets[0];
  const out = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n < 2) return;
    const g = i => plain(row.getCell(i).value);
    const cells = [1, 2, 3, 4, 5].map(g);
    if (cells.every(c => c === null || c === '')) return;
    out.push({
      date: fmtDate(cells[0]), number: cells[1] ?? '', ksef: cells[2] ?? '',
      contractor: cells[3] ?? '', amount: cells[4] ?? '', cents: toCents(cells[4]),
    });
  });
  return out;
}

async function readLedger(path) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ledger = {};
  for (const ws of wb.worksheets) {
    const name = norm(ws.name);
    const idx = MONTHS.findIndex(m => name.includes(m));
    if (idx < 0) continue;
    const data = { przychod: new Map(), koszt: new Map() };
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (n < 6) return;
      const lp = plain(row.getCell(1).value);
      if (lp === null || lp === '') return;
      const firma = plain(row.getCell(5).value) ?? '';
      for (const [key, col] of [['przychod', 13], ['koszt', 17]]) {
        const c = toCents(row.getCell(col).value);
        if (!c) continue;
        const k = Math.abs(c);
        if (!data[key].has(k)) data[key].set(k, []);
        data[key].get(k).push({ lp, firma });
      }
    });
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
