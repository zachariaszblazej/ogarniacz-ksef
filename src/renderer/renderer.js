const $ = id => document.getElementById(id);
const paths = { inv: null, led: null };
let fullPlan = [];      // plan z matchera (indeks = id zmatchowanej operacji)
let matchOn = [];       // przełączniki operacji
let cellOff = new Set(); // wyłączone komórki: "id:b" / "id:c" / "id:f"
const CELLS = ['b', 'c', 'f'];

// Nowe operacje (z faktur niezmatchowanych z powodu braku matchy)
let additions = [];       // z matchera (indeks = id)
let freeRows = {};        // arkusz -> [{ row, lp }] wolne wiersze
let addOn = [];           // przełączniki: czy dopisać fakturę
let fuelOn = [];          // checkboxy "Paliwo": kwota do kol. T zamiast P
let addCellOff = new Set(); // wyłączone komórki nowych operacji: "id:b" / "id:c" / "id:e" / "id:f" / "id:amount"
const ADD_CELLS = ['b', 'c', 'e', 'f', 'amount'];

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

    const { matched, unmatched, total, months, plan, additions: adds, free } = res.result;
    fullPlan = plan;
    matchOn = plan.map(() => true);
    cellOff = new Set();
    additions = adds;
    freeRows = free;
    addOn = adds.map(() => true);
    fuelOn = adds.map(() => false);
    addCellOff = new Set();
    if (!months.length) showMsg('W ewidencji nie znaleziono arkuszy z nazwami miesięcy.', true);

    renderMatched(matched);
    renderUnmatched(unmatched);
    $('c-bad').textContent = 'Liczba rekordów: ' + unmatched.length;
    $('s-total').textContent = total;
    $('s-bad').textContent = unmatched.length;
    $('stats').classList.remove('hidden');
    refreshFillState();
};

// ---- Przełącznik (switch) ----
function makeSwitch(title, onChange) {
    const sw = document.createElement('label');
    sw.className = 'switch';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.title = title;
    cb.onchange = () => onChange(cb.checked);
    const knob = document.createElement('span');
    knob.className = 'knob';
    sw.append(cb, knob);
    return sw;
}

// ---- Lista zmatchowanych: przełączniki aktywności ----
function renderMatched(matched) {
    const tbody = $('t-ok');
    tbody.replaceChildren();
    if (!matched.length) {
        const td = tbody.insertRow().insertCell();
        td.colSpan = 7;
        td.className = 'empty';
        td.textContent = 'Brak rekordów';
        return;
    }
    matched.forEach((r, i) => {
        const tr = tbody.insertRow();
        tr.dataset.idx = i;
        tr.insertCell().appendChild(makeSwitch('Uwzględnij tę operację w zmianach ewidencji', on => {
            matchOn[i] = on;
            tr.classList.toggle('off', !on);
            refreshFillState();
        }));
        for (const k of ['lp', 'amount', 'ksef', 'contractor', 'firma', 'uwagi']) {
            const td = tr.insertCell();
            td.textContent = r[k] ?? '';
            if (k === 'amount') td.className = 'num';
        }
    });
}

// ---- Lista niezmatchowanych: przełącznik tylko dla faktur bez matchu (do dopisania) ----
function renderUnmatched(unmatched) {
    const tbody = $('t-bad');
    tbody.replaceChildren();
    if (!unmatched.length) {
        const td = tbody.insertRow().insertCell();
        td.colSpan = 8;
        td.className = 'empty';
        td.textContent = 'Brak rekordów';
        return;
    }
    for (const r of unmatched) {
        const tr = tbody.insertRow();
        const first = tr.insertCell();
        if (r.addId !== undefined) {
            first.appendChild(makeSwitch('Dopisz tę fakturę jako nową operację w ewidencji', on => {
                addOn[r.addId] = on;
                tr.classList.toggle('off', !on);
                refreshFillState();
            }));
        } else if (r.alreadyIn) {
            first.textContent = 'już w ewidencji';
            first.className = 'same';
            first.title = 'Numer KSEF tej faktury występuje już w kolumnie „nr FV” ewidencji';
        }
        for (const k of ['date', 'number', 'ksef', 'contractor', 'amount', 'fuel', 'reason']) {
            const td = tr.insertCell();
            if (k === 'fuel') {
                if (r.canFuel) {
                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.checked = false;
                    cb.title = 'Faktura paliwowa: wpisz kwotę w kolumnie T (koszty brutto paliwo) zamiast P';
                    cb.onchange = () => { fuelOn[r.addId] = cb.checked; refreshFillState(); };
                    td.appendChild(cb);
                }
                continue;
            }
            td.textContent = r[k] ?? '';
            if (k === 'amount') td.className = 'num';
        }
    }
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

// Skuteczne nowe operacje: włączone, z co najmniej jedną włączoną komórką.
// Każda dostaje kolejny wolny wiersz w swoim arkuszu (slot = null, gdy wolnych wierszy zabrakło).
function effectiveAdds() {
    const pools = new Map();
    const out = [];
    additions.forEach((a, id) => {
        if (!addOn[id]) return;
        const cells = ADD_CELLS.filter(c => (c !== 'f' || a.f) && !addCellOff.has(id + ':' + c));
        if (!cells.length) return;
        if (!pools.has(a.sheet)) pools.set(a.sheet, [...(freeRows[a.sheet] || [])]);
        out.push({ id, a, cells, slot: pools.get(a.sheet).shift() || null });
    });
    return out;
}

function refreshFillState() {
    const matchedCount = fullPlan.length;
    const active = matchOn.filter(Boolean).length;
    const eff = effectivePlan();
    const newCount = addOn.filter(Boolean).length;
    $('c-ok').textContent = `Liczba rekordów: ${matchedCount} (aktywnych: ${active})`;
    $('s-ok').textContent = active;
    $('fill').disabled = eff.length === 0 && effectiveAdds().length === 0;
    $('fill-info').textContent = matchedCount === 0 ? ''
        : fullPlan.every(p => !p.hasChanges) ? 'Ewidencja jest już uzupełniona – brak zmian do zapisania.'
            : `Do zmiany: ${eff.length} z ${matchedCount} operacji.`;
    $('new-info').textContent = `Nowych operacji: ${newCount}`;
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
    const adds = effectiveAdds();
    const missing = adds.filter(e => !e.slot).length;
    const cells = eff.reduce((n, e) => n + e.cells.length, 0);
    const sheets = [...new Set([...eff.map(e => e.p.sheet), ...adds.map(e => e.a.sheet)])];
    let text = `Zostanie zmienionych ${cells} komórek w ${eff.length} istniejących operacjach` +
        ` i dopisanych ${adds.length} nowych operacji (arkusze: ${sheets.join(', ') || '—'}). ` +
        'Kliknij komórkę, aby ją wyłączyć (niebieska = pominięta).';
    if (missing) {
        text += ` UWAGA: brakuje wolnych wierszy dla ${missing} nowych operacji – wyłącz je, aby zapisać.`;
    }
    $('m-summary').textContent = text;
    $('m-summary').classList.toggle('error', missing > 0);
    $('m-ok').disabled = !($('m-ack').checked && (eff.length > 0 || adds.length > 0) && missing === 0);
    $('fill').disabled = eff.length === 0 && adds.length === 0;
}

// Podgląd nowych operacji: numery wierszy zależą od aktualnie włączonych pozycji
function renderNewOps() {
    const body = $('m-new-body');
    body.replaceChildren();
    const slots = new Map(effectiveAdds().map(e => [e.id, e.slot]));
    additions.forEach((a, id) => {
        if (!addOn[id]) return;
        const tr = body.insertRow();
        const slot = slots.get(id);
        tr.insertCell().textContent = a.sheet;
        const rowCell = tr.insertCell();
        const lpCell = tr.insertCell();
        if (slots.has(id) && !slot) {
            rowCell.textContent = 'brak wolnego wiersza';
            rowCell.className = 'error-text';
            lpCell.textContent = '—';
        } else {
            rowCell.textContent = slot ? slot.row : '—';
            lpCell.textContent = slot ? slot.lp : '—';
        }
        const isFuel = Boolean(fuelOn[id] && a.cost);
        const value = {
            b: a.b, c: a.c, e: a.e, f: a.f ? a.f.text : '',
            amount: (isFuel ? a.fuelAmount : a.amount).replace('.', ','),
        };
        const amountCol = isFuel ? 'T' : a.amountCol;
        // kolumny podglądu; L, P i T są osobno, ale odpowiadają jednej komórce "amount"
        for (const col of ['b', 'c', 'e', 'f', 'L', 'P', 'T']) {
            const td = tr.insertCell();
            const key = col === 'L' || col === 'P' || col === 'T' ? 'amount' : col;
            if (key === 'amount' && col !== amountCol) {
                td.textContent = '—';
                td.className = 'same';
                continue;
            }
            if (key === 'f' && !a.f) {
                td.textContent = '— (brak daty w nr KSEF)';
                td.className = 'same';
                continue;
            }
            const k = id + ':' + key;
            td.className = 'toggle';
            td.title = 'Kliknij, aby włączyć/wyłączyć tę zmianę';
            td.classList.toggle('skip', addCellOff.has(k));
            const o = document.createElement('span');
            o.className = 'old';
            o.textContent = '(puste)';
            const n = document.createElement('span');
            n.className = 'new';
            n.textContent = value[key];
            td.append(o, ' → ', n);
            td.onclick = () => {
                if (addCellOff.has(k)) addCellOff.delete(k); else addCellOff.add(k);
                renderNewOps();
                updateModalSummary();
            };
        }
    });
}

$('fill').onclick = () => {
    const body = $('m-body');
    body.replaceChildren();
    // w podglądzie wszystkie włączone operacje; wyłączone komórki są niebieskie
    let changeRows = 0;
    fullPlan.forEach((p, id) => {
        if (!matchOn[id] || !p.hasChanges) return;
        changeRows++;
        const tr = body.insertRow();
        tr.insertCell().textContent = p.sheet;
        tr.insertCell().textContent = p.row;
        tr.insertCell().textContent = p.lp;
        tr.insertCell().textContent = p.firma ?? '';
        diffCell(tr, id, 'b', p.b);
        diffCell(tr, id, 'c', p.c);
        diffCell(tr, id, 'f', p.f);
    });
    $('m-changes-wrap').classList.toggle('hidden', changeRows === 0);
    renderNewOps();
    $('m-new').classList.toggle('hidden', !addOn.some(Boolean));
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
    const selection = {
        changes: effectivePlan().map(e => ({ id: e.id, cells: e.cells })),
        adds: effectiveAdds().map(e => ({ id: e.id, cells: e.cells, fuel: Boolean(fuelOn[e.id] && e.a.cost) })),
    };
    $('m-ok').disabled = true;
    $('m-ok').textContent = 'Zapisuję…';
    const r = await api.apply(selection);
    $('m-ok').textContent = 'Zapisz zmiany w Excelu';
    $('modal').classList.add('hidden');
    if (!r.ok) return showMsg('Błąd zapisu: ' + r.error);
    fullPlan = [];
    matchOn = [];
    cellOff = new Set();
    additions = [];
    freeRows = {};
    addOn = [];
    addCellOff = new Set();
    $('fill').disabled = true;
    $('fill-info').textContent = '';
    $('new-info').textContent = '';
    showMsg(`Zapisano: zmiany w ${r.changedRecords} wierszach, dopisano ${r.addedRecords} nowych operacji. ` +
        `Kopia zapasowa: ${r.backup}`, true);
};

$('open-backups').onclick = () => api.openBackups();

// ---- Wyczyść wszystko: powrót do stanu początkowego ----
$('reset').onclick = async () => {
    await api.reset();
    paths.inv = paths.led = null;
    for (const k of ['inv', 'led']) {
        $('f-' + k).textContent = 'Nie wybrano pliku';
        $('p-' + k).classList.remove('set');
    }
    $('run').disabled = true;
    $('run').textContent = 'Dopasuj';
    $('msg').className = 'msg hidden';
    $('stats').classList.add('hidden');
    for (const id of ['s-total', 's-ok', 's-bad']) $(id).textContent = '0';
    $('t-ok').replaceChildren();
    $('t-bad').replaceChildren();
    $('c-ok').textContent = 'Liczba rekordów: 0';
    $('c-bad').textContent = 'Liczba rekordów: 0';
    fullPlan = [];
    matchOn = [];
    cellOff = new Set();
    additions = [];
    freeRows = {};
    addOn = [];
    addCellOff = new Set();
    $('fill').disabled = true;
    $('fill-info').textContent = '';
    $('new-info').textContent = '';
    $('m-body').replaceChildren();
    $('m-new-body').replaceChildren();
    $('m-ack').checked = false;
    $('modal').classList.add('hidden');
};
