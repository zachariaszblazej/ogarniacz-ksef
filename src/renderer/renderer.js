const MONTH_NAMES = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];
const $ = id => document.getElementById(id);
const paths = { inv: null, led: null };

function setPath(key, p) {
  if (!p) return;
  paths[key] = p;
  $('f-' + key).textContent = p;
  $('p-' + key).classList.add('set');
  $('run').disabled = !(paths.inv && paths.led);
}

$('b-inv').onclick = async () => setPath('inv', await api.pickFile('Lista faktur od księgowej'));
$('b-led').onclick = async () => setPath('led', await api.pickFile('Ewidencja operacji finansowych'));

function fill(tbody, rows, keys, numKey) {
  tbody.replaceChildren();
  if (!rows.length) {
    const tr = tbody.insertRow();
    const td = tr.insertCell();
    td.colSpan = keys.length;
    td.className = 'empty';
    td.textContent = 'Brak rekordów';
    return;
  }
  for (const r of rows) {
    const tr = tbody.insertRow();
    for (const k of keys) {
      const td = tr.insertCell();
      td.textContent = r[k] ?? '';
      if (k === numKey) td.className = 'num';
    }
  }
}

function showMsg(text, info) {
  const m = $('msg');
  m.textContent = text;
  m.className = 'msg' + (info ? ' info' : '');
}

$('run').onclick = async () => {
  $('msg').className = 'msg hidden';
  $('run').disabled = true;
  $('run').textContent = 'Liczę…';
  const res = await api.match(paths.inv, paths.led);
  $('run').textContent = 'Dopasuj';
  $('run').disabled = false;
  if (!res.ok) return showMsg('Błąd: ' + res.error);

  const { matched, unmatched, total, months } = res.result;
  if (!months.length) showMsg('W ewidencji nie znaleziono arkuszy z nazwami miesięcy.', true);

  fill($('t-ok'), matched, ['lp', 'amount', 'ksef', 'contractor', 'firma'], 'amount');
  fill($('t-bad'), unmatched, ['date', 'number', 'ksef', 'contractor', 'amount'], 'amount');
  $('c-ok').textContent = 'Liczba rekordów: ' + matched.length;
  $('c-bad').textContent = 'Liczba rekordów: ' + unmatched.length;
  $('s-total').textContent = total;
  $('s-ok').textContent = matched.length;
  $('s-bad').textContent = unmatched.length;
  $('s-months').textContent = months.length ? months.map(m => MONTH_NAMES[m - 1]).join(', ') : '–';
  $('stats').classList.remove('hidden');
};
