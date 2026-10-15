const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function attrsOf(tag) {
    const out = {};
    for (const m of tag.matchAll(/([\w:]+)="([^"]*)"/g)) out[m[1]] = m[2];
    return out;
}

// nazwa arkusza -> ścieżka pliku XML w paczce
async function sheetPaths(zip) {
    const wbXml = await zip.file('xl/workbook.xml').async('string');
    const relXml = await zip.file('xl/_rels/workbook.xml.rels').async('string');
    const rels = {};
    for (const m of relXml.matchAll(/<Relationship\b[^>]*>/g)) {
        const a = attrsOf(m[0]);
        rels[a.Id] = a.Target;
    }
    const out = {};
    for (const m of wbXml.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
        const a = attrsOf(m[0]);
        const target = rels[a['r:id']];
        if (!target) continue;
        out[unesc(a.name)] = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
    }
    return out;
}

// Podmienia zawartość komórki, zachowując jej styl
function setCell(xml, ref, kind, value) {
    const re = new RegExp(`<c r="${ref}"((?:\\s+[\\w:]+="[^"]*")*)\\s*(?:/>|>[\\s\\S]*?</c>)`);
    const m = re.exec(xml);
    if (!m) throw new Error(`Nie znaleziono komórki ${ref} w arkuszu.`);
    const attrs = m[1].replace(/\s+t="[^"]*"/, '');
    const cell = kind === 'num'
        ? `<c r="${ref}"${attrs}><v>${value}</v></c>`
        : `<c r="${ref}"${attrs} t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
    return xml.slice(0, m.index) + cell + xml.slice(m.index + m[0].length);
}

async function applyPlan(file, plan, backupDir) {
    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    const paths = await sheetPaths(zip);
    const bySheet = new Map();
    for (const it of plan) {
        if (!it.hasChanges) continue;
        if (!bySheet.has(it.sheet)) bySheet.set(it.sheet, []);
        bySheet.get(it.sheet).push(it);
    }

    let changedRecords = 0;
    for (const [sheet, items] of bySheet) {
        const p = paths[sheet];
        if (!p || !zip.file(p)) throw new Error(`Nie znaleziono arkusza „${sheet}”.`);
        let xml = await zip.file(p).async('string');
        for (const it of items) {
            if (it.b.changed) xml = setCell(xml, `B${it.row}`, 'str', it.b.new);
            if (it.c.changed) xml = setCell(xml, `C${it.row}`, 'str', it.c.new);
            if (it.f.changed && it.f.serial !== null) {
                xml = it.f.asText
                    ? setCell(xml, `F${it.row}`, 'str', it.f.new)
                    : setCell(xml, `F${it.row}`, 'num', it.f.serial);
            }
            changedRecords++;
        }
        zip.file(p, xml);
    }
    if (!changedRecords) return { changedRecords: 0, backup: null };

    // wymuś przeliczenie formuł przy otwarciu
    let wb = await zip.file('xl/workbook.xml').async('string');
    if (/<calcPr\b/.test(wb) && !/fullCalcOnLoad=/.test(wb)) {
        wb = wb.replace(/<calcPr\b/, '<calcPr fullCalcOnLoad="1"');
        zip.file('xl/workbook.xml', wb);
    }

    const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

    // kopia zapasowa: w podanym katalogu (domyślnie obok oryginału)
    const d = new Date();
    const p2 = x => String(x).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    const parsed = path.parse(file);
    const dir = backupDir || parsed.dir;
    fs.mkdirSync(dir, { recursive: true });
    const backup = path.join(dir, `${parsed.name}.backup-${stamp}${parsed.ext}`);
    fs.copyFileSync(file, backup);

    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, file);
    return { changedRecords, backup };
}

module.exports = { applyPlan };
