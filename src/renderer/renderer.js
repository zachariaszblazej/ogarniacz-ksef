const MONTH_NAMES = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];
const $ = id => document.getElementById(id);
const paths = { inv: null, led: null };
let currentPlan = [];

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

    const { matched, unmatched, total, months, plan } = res.result;
    currentPlan = plan.filter(p => p.hasChanges);
    $('fill').disabled = currentPlan.length === 0;
    $('fill-info').textContent = matched.length === 0 ? ''
        : currentPlan.length === 0 ? 'Ewidencja jest już uzupełniona – brak zmian do zapisania.'
            : `Do zmiany: ${currentPlan.length} z ${matched.length} operacji.`;
    if (!months.length) showMsg('W ewidencji nie znaleziono arkuszy z nazwami miesięcy.', true);

    fill($('t-ok'), matched, ['lp', 'amount', 'ksef', 'contractor', 'firma'], 'amount');
    fill($('t-bad'), unmatched, ['date', 'number', 'ksef', 'contractor', 'amount', 'reason'], 'amount');
    $('c-ok').textContent = 'Liczba rekordów: ' + matched.length;
    $('c-bad').textContent = 'Liczba rekordów: ' + unmatched.length;
    $('s-total').textContent = total;
    $('s-ok').textContent = matched.length;
    $('s-bad').textContent = unmatched.length;
    $('s-months').textContent = months.length ? months.map(m => MONTH_NAMES[m - 1]).join(', ') : '–';
    $('stats').classList.remove('hidden');
};

// ---- Uzupełnianie ewidencji: podgląd zmian i zgoda ----
function diffCell(tr, c) {
    const td = tr.insertCell();
    if (!c.changed) {
        td.textContent = c.old === '' ? '—' : c.old;
        td.className = 'same';
        return;
    }
    const o = document.createElement('span');
    o.className = 'old';
    o.textContent = c.old === '' ? '(puste)' : c.old;
    const n = document.createElement('span');
    n.className = 'new';
    n.textContent = c.new;
    td.append(o, ' → ', n);
}

$('fill').onclick = () => {
    const body = $('m-body');
    body.replaceChildren();
    for (const p of currentPlan) {
        const tr = body.insertRow();
        tr.insertCell().textContent = p.sheet;
        tr.insertCell().textContent = p.row;
        tr.insertCell().textContent = p.lp;
        diffCell(tr, p.b);
        diffCell(tr, p.c);
        diffCell(tr, p.f);
    }
    $('m-summary').textContent =
        `Zostanie zmienionych ${currentPlan.length} wierszy w ewidencji (arkusze: ` +
        `${[...new Set(currentPlan.map(p => p.sheet))].join(', ')}). ` +
        'Stare wartości są przekreślone, nowe – wyróżnione.';
    $('m-ack').checked = false;
    $('m-ok').disabled = true;
    $('modal').classList.remove('hidden');
};

$('m-ack').onchange = () => { $('m-ok').disabled = !$('m-ack').checked; };
$('m-cancel').onclick = () => $('modal').classList.add('hidden');
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') $('modal').classList.add('hidden');
});

$('m-ok').onclick = async () => {
    $('m-ok').disabled = true;
    $('m-ok').textContent = 'Zapisuję…';
    const r = await api.apply();
    $('m-ok').textContent = 'Zapisz zmiany w Excelu';
    $('modal').classList.add('hidden');
    if (!r.ok) return showMsg('Błąd zapisu: ' + r.error);
    currentPlan = [];
    $('fill').disabled = true;
    $('fill-info').textContent = '';
    showMsg(`Zapisano zmiany w ${r.changedRecords} wierszach. Kopia zapasowa: ${r.backup}`, true);
};
