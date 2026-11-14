const $ = id => document.getElementById(id);
api.version().then(v => { $('version').textContent = 'v' + v; });
$('help-btn').onclick = () => api.openHelp();
const paths = { inv: null, xml: null, pdf: null, led: null };
let fullPlan = [];      // plan z matchera (indeks = id zmatchowanej operacji)
let matchOn = [];       // przełączniki operacji
let cellOff = new Set(); // wyłączone komórki: "id:b" / "id:c" / "id:f"
let pickInv = new Set(); // G/H, w których wybrano datę z faktury zamiast tej z ewidencji: "id:g" / "id:h"
let dateCells = []; // komórki G/H tabeli dopasowanych: { td, i, col } - do przerysowania po zmianie ustawienia
const CELLS = ['b', 'c', 'f', 'g', 'h'];

// Nowe operacje (z faktur niezmatchowanych z powodu braku matchy)
let additions = [];       // z matchera (indeks = id)
let freeRows = {};        // arkusz -> [{ row, lp }] wolne wiersze
let addOn = [];           // przełączniki: czy dopisać fakturę
let fuelOn = [];          // rodzaj kosztu per faktura: '' (zwykły) | 'fuel' (paliwo, S-U) | 'inni' (X, Y) - wzajemnie wykluczające się
let eEdit = [];           // ręcznie poprawiona nazwa firmy (kol. E) per nowa operacja; '' = propozycja programu
let zlEdit = [];          // tekst z kolumny "ZL" -> kol. D nowego wiersza
let noteEdit = [];        // tekst z kolumny "Uwagi" -> kol. Z nowego wiersza
const kindOf = (a, id) => (a.cost ? fuelOn[id] || '' : '');
let addCellOff = new Set(); // wyłączone komórki nowych operacji: "id:b" / "id:c" / "id:e" / "id:f" / "id:amount"
const ADD_CELLS = ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'net', 'gross', 'vat', 'z'];
// które komórki kwot dotyczą danej faktury: zwykłej (netto/brutto/VAT) albo paliwowej (tylko T)
const AMOUNT_KEYS = ['net', 'gross', 'vat'];
const isFuelAdd = (a, id) => kindOf(a, id) === 'fuel';

function setPath(key, p) {
    if (!p) return;
    paths[key] = p;
    $('f-' + key).textContent = p;
    $('p-' + key).classList.add('set');
    $('run').disabled = !(paths.inv && paths.xml && paths.pdf && paths.led);
}

$('b-inv').onclick = async () => setPath('inv', await api.pickFile('Lista faktur od księgowej'));
$('b-led').onclick = async () => setPath('led', await api.pickFile('Ewidencja operacji finansowych'));
$('b-xml').onclick = async () => setPath('xml', await api.pickDir('Folder z fakturami XML (nr KSEF.xml)'));
$('b-pdf').onclick = async () => setPath('pdf', await api.pickDir('Folder z fakturami PDF (nr KSEF.pdf)'));

// ---- Tryb wczytywania: jeden folder (lista ZAKUP + XML + PDF) albo osobno; ustawienie pamiętane między sesjami ----
function applyMode(bundle) {
    for (const id of ['p-inv', 'p-xml', 'p-pdf']) $(id).classList.toggle('hidden', bundle);
    $('p-bundle').classList.toggle('hidden', !bundle);
    $('pickers').style.setProperty('--picker-count', bundle ? 2 : 4);
}

// Czyści wybór listy, XML i PDF (ewidencja zostaje)
function clearSourcePaths() {
    paths.inv = paths.xml = paths.pdf = null;
    for (const k of ['inv', 'xml', 'pdf', 'bundle']) {
        $('f-' + k).textContent = k === 'inv' ? 'Nie wybrano pliku' : 'Nie wybrano folderu';
        $('p-' + k).classList.remove('set');
    }
    $('run').disabled = true;
}

$('bundle-toggle').checked = localStorage.getItem('bundleMode') !== '0'; // domyślnie włączony
applyMode($('bundle-toggle').checked);
$('bundle-toggle').onchange = () => {
    localStorage.setItem('bundleMode', $('bundle-toggle').checked ? '1' : '0');
    clearSourcePaths();
    applyMode($('bundle-toggle').checked);
};

// Ustawienie (pamiętane między sesjami, domyślnie włączone): opłacone pozycje - tylko informacja zamiast przełącznika dat
let paidInfo = localStorage.getItem('paidInfo') !== '0';
$('paid-info-toggle').checked = paidInfo;
$('paid-info-toggle').onchange = () => {
    paidInfo = $('paid-info-toggle').checked;
    localStorage.setItem('paidInfo', paidInfo ? '1' : '0');
    // wybór „z faktury” w opłaconych pozycjach nie ma sensu, gdy pokazujemy tylko informację
    if (paidInfo) fullPlan.forEach((p, id) => { if (p.paidBoth) { pickInv.delete(id + ':g'); pickInv.delete(id + ':h'); } });
    for (const { td, i, col } of dateCells) {
        td.replaceChildren();
        td.className = '';
        dateStatusCell(td, fullPlan[i], i, col);
    }
    refreshFillState();
};

$('b-bundle').onclick = async () => {
    const res = await api.pickBundle('Folder z fakturami (lista ZAKUP, folder XML, folder PDF)');
    if (!res) return;
    if (!res.ok) return showMsg('Błąd: ' + res.error);
    $('msg').className = 'msg hidden';
    setPath('inv', res.inv);
    setPath('xml', res.xml);
    setPath('pdf', res.pdf);
    const f = $('f-bundle');
    f.replaceChildren();
    for (const [label, p] of [['Lista faktur', res.inv], ['Folder XML', res.xml], ['Folder PDF', res.pdf]]) {
        const line = document.createElement('div');
        const b = document.createElement('b');
        b.textContent = label + ': ';
        line.append(b, p);
        f.append(line);
    }
    $('p-bundle').classList.add('set');
};

// Przycisk otwierający PDF faktury; nieaktywny, gdy pliku nie ma w folderze
function pdfButton(r) {
    const b = document.createElement('button');
    b.className = 'ghost pdf-btn';
    b.textContent = 'PDF';
    b.disabled = !r.pdf;
    b.title = r.pdf ? 'Otwórz fakturę PDF' : 'Brak pliku PDF w wybranym folderze';
    b.onclick = async () => {
        const res = await api.openPdf(r.ksef);
        if (!res.ok) showMsg('Błąd: ' + res.error);
    };
    return b;
}

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
            if (k === 'pdf') { td.appendChild(pdfButton(r)); continue; }
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

// Okno potwierdzenia: OK -> true, Anuluj lub Esc -> false (zamyka tylko to okno)
function askConfirm(text) {
    return new Promise(resolve => {
        $('cf-text').textContent = text;
        $('confirm').classList.remove('hidden');
        $('cf-cancel').focus(); // bezpieczniejszy domyślny wybór przy kasowaniu pracy
        const onKey = e => { if (e.key === 'Escape') close(false); };
        const close = result => {
            $('confirm').classList.add('hidden');
            $('cf-ok').onclick = $('cf-cancel').onclick = null;
            document.removeEventListener('keydown', onKey);
            resolve(result);
        };
        document.addEventListener('keydown', onKey);
        $('cf-ok').onclick = () => close(true);
        $('cf-cancel').onclick = () => close(false);
    });
}

// Praca jest w programie, gdy wyświetlone są wyniki dopasowania
async function confirmDiscard() {
    const hasWork = !$('stats').classList.contains('hidden');
    return !hasWork || await askConfirm('To skasuje obecną pracę. Czy na pewno chcesz kontynuować?');
}

$('run').onclick = async () => {
    if (!(await confirmDiscard())) return;
    $('msg').className = 'msg hidden';
    $('run').disabled = true;
    $('run').textContent = 'Liczę…';
    const res = await api.match(paths.inv, paths.led, paths.xml, paths.pdf);
    $('run').textContent = 'Dopasuj';
    $('run').disabled = false;
    if (!res.ok) return showMsg('Błąd: ' + res.error);

    const { matched, unmatched, already, total, months, plan, additions: adds, free } = res.result;
    fullPlan = plan;
    matchOn = plan.map(() => true);
    cellOff = new Set();
    pickInv = new Set();
    additions = adds;
    freeRows = free;
    addOn = adds.map(() => true);
    fuelOn = adds.map(() => '');
    eEdit = adds.map(() => '');
    zlEdit = adds.map(() => '');
    noteEdit = adds.map(() => '');
    addCellOff = new Set();
    if (!months.length) showMsg('W ewidencji nie znaleziono arkuszy z nazwami miesięcy.', true);

    renderMatched(matched);
    renderUnmatched(unmatched);
    fill($('t-already'), already, ['pdf', 'date', 'ksef', 'contractor', 'amount'], 'amount');
    $('c-already').textContent = 'Liczba rekordów: ' + already.length;
    $('s-already').textContent = already.length;
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

// Etykieta przy kursorze (w prawym górnym rogu): FAKTURA albo EWIDENCJA nad datą do wyboru
const cursorTip = document.createElement('div');
cursorTip.className = 'cursor-tip hidden';
document.body.append(cursorTip);
function moveTip(e) {
    cursorTip.style.left = Math.min(e.clientX + 12, window.innerWidth - cursorTip.offsetWidth - 4) + 'px';
    cursorTip.style.top = Math.max(e.clientY - 26, 4) + 'px';
}
function showTip(text, e) {
    cursorTip.textContent = text;
    cursorTip.classList.remove('hidden');
    moveTip(e);
}
const hideTip = () => cursorTip.classList.add('hidden');

// ---- Lista zmatchowanych: przełączniki aktywności ----
// Data z XML w kolumnie G/H: do pustej komórki wpisujemy ją sami; gdy w ewidencji coś już jest i się różni,
// użytkownik przełącza między wartością z ewidencji (domyślnie) a wartością z faktury (wyróżniona)
function dateStatusCell(td, p, id, col) {
    const c = p[col];
    if (c.status === 'same') {
        td.textContent = 'już jest';
        td.className = 'same';
    } else if (c.status === 'diff' && (!c.alt || (paidInfo && p.paidBoth))) {
        td.textContent = 'już jest, ale się różnią'; // opłacona pozycja: tylko informacja
        td.className = 'same';
    } else if (c.status === 'diff') {
        const key = id + ':' + col;
        const group = document.createElement('span');
        group.className = 'seg-group';
        const mk = (text, title, fromInvoice) => {
            const s = document.createElement('span');
            s.className = 'seg' + (fromInvoice ? ' inv' : '');
            s.textContent = text;
            s.setAttribute('aria-label', title);
            s.addEventListener('mouseenter', e => showTip(fromInvoice ? 'FAKTURA' : 'EWIDENCJA', e));
            s.addEventListener('mousemove', moveTip);
            s.addEventListener('mouseleave', hideTip);
            s.onclick = () => {
                if (fromInvoice) pickInv.add(key); else pickInv.delete(key);
                paint();
                refreshFillState();
            };
            return s;
        };
        const ledgerSeg = mk(c.old, 'Wartość z ewidencji (zostaje bez zmian)', false);
        const invoiceSeg = mk(c.alt.text + (c.alt.auto ? ' (auto)' : ''), 'Wartość z faktury (zastąpi tę z ewidencji)', true);
        const paint = () => {
            const inv = pickInv.has(key);
            ledgerSeg.classList.toggle('on', !inv);
            invoiceSeg.classList.toggle('on', inv);
        };
        paint();
        group.append(ledgerSeg, invoiceSeg);
        td.append(group);
    } else if (c.status === 'new') {
        td.textContent = c.new;
        if (c.auto) {
            const auto = document.createElement('span');
            auto.className = 'same';
            auto.textContent = ' (auto)';
            td.append(auto);
        }
    }
}

function renderMatched(matched) {
    const tbody = $('t-ok');
    dateCells = [];
    tbody.replaceChildren();
    if (!matched.length) {
        const td = tbody.insertRow().insertCell();
        td.colSpan = 11;
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
        for (const k of ['pdf', 'date', 'lp', 'ksef', 'contractor', 'firma', 'gTerm', 'hPaid', 'amount', 'uwagi']) {
            const td = tr.insertCell();
            if (k === 'pdf') { td.appendChild(pdfButton(r)); continue; }
            if (k === 'gTerm' || k === 'hPaid') {
                const col = k === 'gTerm' ? 'g' : 'h';
                dateCells.push({ td, i, col });
                dateStatusCell(td, fullPlan[i], i, col);
                continue;
            }
            td.textContent = r[k] ?? '';
            if (k === 'amount') td.className = 'num';
        }
    });
}

// Komórka edytowalna jak w Excelu: dwuklik otwiera edycję, Enter lub kliknięcie poza komórką zapisuje, Esc anuluje.
// store[id] trzyma ręczną wartość ('' = brak, wtedy pokazujemy base).
function makeEditable(td, store, id, base, title) {
    const show = () => {
        td.textContent = store[id] || base;
    };
    td.classList.add('editable');
    td.title = title;
    show();
    td.ondblclick = () => {
        if (td.querySelector('input')) return;
        const cs = getComputedStyle(td);
        const startW = td.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'cell-edit';
        input.value = store[id] || base;
        input.style.minWidth = startW + 'px';
        const fit = () => { input.size = Math.max(10, input.value.length + 1); };
        fit();
        let done = false;
        const finish = save => {
            if (done) return;
            done = true;
            if (save) {
                const v = input.value.trim();
                store[id] = v && v !== base ? v : '';
            }
            show();
        };
        input.oninput = fit;
        input.onblur = () => finish(true);
        input.onkeydown = e => {
            if (e.key === 'Enter') finish(true);
            else if (e.key === 'Escape') finish(false);
        };
        td.replaceChildren(input);
        input.focus();
        input.select();
    };
}

// ---- Lista niezmatchowanych: przełącznik tylko dla faktur bez matchu (do dopisania) ----
function renderUnmatched(unmatched) {
    const tbody = $('t-bad');
    tbody.replaceChildren();
    if (!unmatched.length) {
        const td = tbody.insertRow().insertCell();
        td.colSpan = 13;
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
        const kindBoxes = {};
        for (const k of ['pdf', 'date', 'zl', 'ksef', 'contractor', 'due', 'paid', 'amount', 'fuel', 'inni', 'uwagi', 'reason']) {
            const td = tr.insertCell();
            if (k === 'pdf') { td.appendChild(pdfButton(r)); continue; }
            if (k === 'fuel' || k === 'inni') {
                if (r.canFuel) {
                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.checked = false;
                    cb.title = k === 'fuel'
                        ? 'Faktura paliwowa: netto, brutto i VAT trafią do kolumn S, T, U zamiast P, Q, R'
                        : 'Inni robią zakupy: netto i VAT trafią do kolumn X, Y (bez brutto)';
                    kindBoxes[k] = cb;
                    cb.onchange = () => {
                        // paliwo i „inni” wykluczają się wzajemnie
                        if (cb.checked) for (const o of Object.keys(kindBoxes)) if (o !== k) kindBoxes[o].checked = false;
                        fuelOn[r.addId] = cb.checked ? k : '';
                        refreshFillState();
                    };
                    td.appendChild(cb);
                }
                continue;
            }
            if (k === 'contractor' && r.addId !== undefined) {
                makeEditable(td, eEdit, r.addId, r.contractor, 'Kliknij dwukrotnie, aby edytować nazwę firmy (kolumna E)');
                continue;
            }
            if (k === 'zl' || k === 'uwagi') {
                if (r.addId !== undefined) {
                    const isZl = k === 'zl';
                    makeEditable(td, isZl ? zlEdit : noteEdit, r.addId, '',
                        isZl ? 'Kliknij dwukrotnie, aby wpisać ZL (kolumna D)' : 'Kliknij dwukrotnie, aby wpisać uwagi (kolumna Z)');
                }
                continue;
            }
            td.textContent = r[k] ?? '';
            if (k === 'amount') td.className = 'num';
        }
    }
}

// Widok komórki planu z uwzględnieniem wyboru daty z faktury zamiast tej z ewidencji (G/H)
function cellView(id, key, c) {
    if (c.status === 'diff' && c.alt && pickInv.has(id + ':' + key)) {
        return { old: c.old, new: c.alt.text, changed: true, auto: c.alt.auto };
    }
    return c;
}

// Skuteczny plan: tylko włączone operacje i włączone komórki
function effectivePlan() {
    const out = [];
    fullPlan.forEach((p, id) => {
        if (!matchOn[id]) return;
        const cells = CELLS.filter(c => cellView(id, c, p[c]).changed && !cellOff.has(id + ':' + c));
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
        const inni = kindOf(a, id) === 'inni';
        const cells = ADD_CELLS.filter(c => (c !== 'f' || a.f) && (c !== 'g' || a.g) && (c !== 'h' || a.h) &&
            (c !== 'd' || zlEdit[id]) && (c !== 'z' || noteEdit[id]) && !(inni && c === 'gross') &&
            !(c === 'net' && a.amount === null) && !(c === 'vat' && a.vat === null) &&
            !addCellOff.has(id + ':' + c));
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
    $('s-ok').textContent = matchedCount;
    $('fill').disabled = eff.length === 0 && effectiveAdds().length === 0;
    $('fill-info').textContent = matchedCount === 0 ? ''
        : fullPlan.every(p => !p.hasChanges) && eff.length === 0 ? 'Ewidencja jest już uzupełniona – brak zmian do zapisania.'
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
    if (c.auto) { // termin wzięty z daty faktycznej zapłaty
        const auto = document.createElement('span');
        auto.className = 'same';
        auto.textContent = ' (auto)';
        td.append(auto);
    }
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
        const lpCell = tr.insertCell();
        if (slots.has(id) && !slot) {
            lpCell.textContent = 'brak';
            lpCell.title = 'Brak wolnego wiersza w arkuszu';
            lpCell.className = 'error-text';
        } else {
            lpCell.textContent = slot ? slot.lp : '—';
        }
        tr.insertCell().appendChild(pdfButton(a));
        const isFuel = isFuelAdd(a, id);
        const comma = s => (s === null ? null : s.replace('.', ','));
        const value = {
            b: a.b, c: a.c, d: zlEdit[id] || '', e: eEdit[id] || a.e, f: a.f ? a.f.text : '', g: a.g ? a.g.text : '', h: a.h ? a.h.text : '', z: noteEdit[id] || '',
            net: comma(a.amount), gross: comma(a.gross), vat: comma(a.vat),
        };
        // kolumna podglądu -> klucz komórki; każda komórka kwoty włącza się/wyłącza osobno
        const colKey = { b: 'b', c: 'c', d: 'd', e: 'e', f: 'f', g: 'g', h: 'h', z: 'z', P: 'net', S: 'net', X: 'net', Q: 'gross', T: 'gross', R: 'vat', U: 'vat', Y: 'vat' };
        const kind = kindOf(a, id);
        const activeCols = kind === 'fuel' ? ['S', 'T', 'U'] : kind === 'inni' ? ['X', 'Y'] : [a.amountCol, a.grossCol, a.vatCol];
        for (const col of ['e', 'verify', 'b', 'c', 'd', 'f', 'g', 'h', 'P', 'Q', 'R', 'S', 'T', 'U', 'X', 'Y', 'z']) {
            if (col === 'verify') {
                const vt = tr.insertCell();
                if (a.verify.ok) {
                    vt.textContent = '✓';
                    vt.className = 'verify-ok';
                    vt.title = 'Suma netto i VAT z pliku XML zgadza się z kwotą brutto z listy';
                } else {
                    vt.textContent = `✗ (${a.verify.text})`;
                    vt.className = 'verify-bad';
                    vt.title = a.verify.text;
                }
                continue;
            }
            const td = tr.insertCell();
            const key = colKey[col];
            if (AMOUNT_KEYS.includes(key)) {
                if (!activeCols.includes(col)) {
                    td.textContent = '—';
                    td.className = 'same';
                    continue;
                }
                if (value[key] === null) {
                    td.textContent = '— (brak XML)';
                    td.className = 'verify-bad';
                    continue;
                }
            }
            if (key === 'f' && !a.f) {
                td.textContent = '— (brak daty na liście)';
                td.className = 'same';
                continue;
            }
            if ((key === 'd' || key === 'g' || key === 'h' || key === 'z') && !value[key]) {
                td.textContent = '—';
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
            if (key === 'g' && a.g.auto) { // termin wzięty z daty faktycznej zapłaty
                const auto = document.createElement('span');
                auto.className = 'same';
                auto.textContent = ' (auto)';
                td.append(auto);
            }
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
        if (!matchOn[id] || !CELLS.some(c => cellView(id, c, p[c]).changed)) return;
        changeRows++;
        const tr = body.insertRow();
        tr.insertCell().textContent = p.sheet;
        tr.insertCell().textContent = p.lp;
        tr.insertCell().appendChild(pdfButton(p));
        tr.insertCell().textContent = p.firma ?? '';
        diffCell(tr, id, 'b', p.b);
        diffCell(tr, id, 'c', p.c);
        diffCell(tr, id, 'f', p.f);
        diffCell(tr, id, 'g', cellView(id, 'g', p.g));
        diffCell(tr, id, 'h', cellView(id, 'h', p.h));
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
        changes: effectivePlan().map(e => ({ id: e.id, cells: e.cells, over: e.cells.filter(c => pickInv.has(e.id + ':' + c)) })),
        adds: effectiveAdds().map(e => ({ id: e.id, cells: e.cells, fuel: kindOf(e.a, e.id) === 'fuel', kind: kindOf(e.a, e.id), e: eEdit[e.id] || '', zl: zlEdit[e.id] || '', uwagi: noteEdit[e.id] || '' })),
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
    if (!(await confirmDiscard())) return;
    await api.reset();
    paths.led = null;
    $('f-led').textContent = 'Nie wybrano pliku';
    $('p-led').classList.remove('set');
    clearSourcePaths();
    $('run').disabled = true;
    $('run').textContent = 'Dopasuj';
    $('msg').className = 'msg hidden';
    $('stats').classList.add('hidden');
    for (const id of ['s-total', 's-ok', 's-bad', 's-already']) $(id).textContent = '0';
    $('t-ok').replaceChildren();
    $('t-already').replaceChildren();
    $('c-already').textContent = 'Liczba rekordów: 0';
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
