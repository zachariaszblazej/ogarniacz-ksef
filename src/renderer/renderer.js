const MONTH_NAMES = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];
const $ = id => document.getElementById(id);
const paths = { inv: null, led: null };
let fullPlan = [];      // plan z matchera (indeks = id zmatchowanej operacji)
let matchOn = [];       // przełączniki operacji
let cellOff = new Set(); // wyłączone komórki: "id:b" / "id:c" / "id:f"
const CELLS = ['b', 'c', 'f'];

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
    fullPlan = plan;
    matchOn = plan.map(() => true);
    cellOff = new Set();
    if (!months.length) showMsg('W ewidencji nie znaleziono arkuszy z nazwami miesięcy.', true);

    renderMatched(matched);
    fill($('t-bad'), unmatched, ['date', 'number', 'ksef', 'contractor', 'amount', 'reason'], 'amount');
    $('c-bad').textContent = 'Liczba rekordów: ' + unmatched.length;
    $('s-total').textContent = total;
    $('s-bad').textContent = unmatched.length;
    $('s-months').textContent = months.length ? months.map(m => MONTH_NAMES[m - 1]).join(', ') : '–';
    $('stats').classList.remove('hidden');
    refreshFillState();
};

// ---- Lista zmatchowanych: przełączniki aktywności ----
function renderMatched(matched) {
    const tbody = $('t-ok');
    tbody.replaceChildren();
    if (!matched.length) {
        const td = tbody.insertRow().insertCell();
        td.colSpan = 6;
        td.className = 'empty';
        td.textContent = 'Brak rekordów';
        return;
    }
    matched.forEach((r, i) => {
        const tr = tbody.insertRow();
        tr.dataset.idx = i;
        const sw = document.createElement('label');
        sw.className = 'switch';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        cb.title = 'Uwzględnij tę operację w zmianach ewidencji';
        cb.onchange = () => {
            matchOn[i] = cb.checked;
            tr.classList.toggle('off', !cb.checked);
            refreshFillState();
        };
        const knob = document.createElement('span');
        knob.className = 'knob';
        sw.append(cb, knob);
        tr.insertCell().appendChild(sw);
        for (const k of ['lp', 'amount', 'ksef', 'contractor', 'firma']) {
            const td = tr.insertCell();
            td.textContent = r[k] ?? '';
            if (k === 'amount') td.className = 'num';
        }
    });
}

// Skuteczny plan: tylko włączone operacje i włączone komórki
function effectivePlan() {
    const out = [];
    fullPlan.forEach((p, id) => {
        if (!matchOn[id]) return;
        const cells = CELLS.filter(c => p[c].changed && !cellOff.has(id + ':' + c));
        if (cells.length) out.push({ id, p, cells });
    });
    return out;
}

function refreshFillState() {
    const matchedCount = fullPlan.length;
    const active = matchOn.filter(Boolean).length;
    const eff = effectivePlan();
    $('c-ok').textContent = `Liczba rekordów: ${matchedCount} (aktywnych: ${active})`;
    $('s-ok').textContent = active;
    $('fill').disabled = eff.length === 0;
    $('fill-info').textContent = matchedCount === 0 ? ''
        : fullPlan.every(p => !p.hasChanges) ? 'Ewidencja jest już uzupełniona – brak zmian do zapisania.'
            : `Do zmiany: ${eff.length} z ${matchedCount} operacji.`;
}

// ---- Uzupełnianie ewidencji: podgląd zmian i zgoda ----
function diffCell(tr, id, key, c) {
    const td = tr.insertCell();
    if (!c.changed) {
        td.textContent = c.old === '' ? '—' : c.old;
        td.className = 'same';
        return;
    }
    td.className = 'toggle';
    td.title = 'Kliknij, aby włączyć/wyłączyć tę zmianę';
    td.classList.toggle('skip', cellOff.has(id + ':' + key));
    const o = document.createElement('span');
    o.className = 'old';
    o.textContent = c.old === '' ? '(puste)' : c.old;
    const n = document.createElement('span');
    n.className = 'new';
    n.textContent = c.new;
    td.append(o, ' → ', n);
    td.onclick = () => {
        const k = id + ':' + key;
        if (cellOff.has(k)) cellOff.delete(k); else cellOff.add(k);
        td.classList.toggle('skip', cellOff.has(k));
        updateModalSummary();
    };
}

function updateModalSummary() {
    const eff = effectivePlan();
    const cells = eff.reduce((n, e) => n + e.cells.length, 0);
    $('m-summary').textContent =
        `Zostanie zmienionych ${cells} komórek w ${eff.length} wierszach ewidencji (arkusze: ` +
        `${[...new Set(eff.map(e => e.p.sheet))].join(', ') || '—'}). ` +
        'Stare wartości są przekreślone, nowe – wyróżnione. Kliknij zmianę, aby ją wyłączyć (szara = pominięta).';
    $('m-ok').disabled = !($('m-ack').checked && eff.length > 0);
    $('fill').disabled = eff.length === 0;
}

$('fill').onclick = () => {
    const body = $('m-body');
    body.replaceChildren();
    // w podglądzie wszystkie włączone operacje; wyłączone komórki są szare
    fullPlan.forEach((p, id) => {
        if (!matchOn[id] || !p.hasChanges) return;
        const tr = body.insertRow();
        tr.insertCell().textContent = p.sheet;
        tr.insertCell().textContent = p.row;
        tr.insertCell().textContent = p.lp;
        diffCell(tr, id, 'b', p.b);
        diffCell(tr, id, 'c', p.c);
        diffCell(tr, id, 'f', p.f);
    });
    $('m-ack').checked = false;
    updateModalSummary();
    $('modal').classList.remove('hidden');
};

$('m-ack').onchange = updateModalSummary;
$('m-cancel').onclick = () => $('modal').classList.add('hidden');
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') $('modal').classList.add('hidden');
});

$('m-ok').onclick = async () => {
    const selection = effectivePlan().map(e => ({ id: e.id, cells: e.cells }));
    $('m-ok').disabled = true;
    $('m-ok').textContent = 'Zapisuję…';
    const r = await api.apply(selection);
    $('m-ok').textContent = 'Zapisz zmiany w Excelu';
    $('modal').classList.add('hidden');
    if (!r.ok) return showMsg('Błąd zapisu: ' + r.error);
    fullPlan = [];
    matchOn = [];
    cellOff = new Set();
    $('fill').disabled = true;
    $('fill-info').textContent = '';
    showMsg(`Zapisano zmiany w ${r.changedRecords} wierszach. Kopia zapasowa: ${r.backup}`, true);
};

$('open-backups').onclick = () => api.openBackups();
