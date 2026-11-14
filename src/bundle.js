const fs = require('fs');
const path = require('path');

const EXCEL_RE = /\.(xlsx|xlsm)$/i;

// Szuka w folderze (tylko bezpośrednio): pliku Excel z "ZAKUP" w nazwie oraz folderów z "XML" i "PDF" w nazwie.
// Zwraca { ok: true, dir, inv, xml, pdf } albo { ok: false, error }.
function scanBundle(dir) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        return { ok: false, error: `Nie można odczytać folderu: ${e.message}` };
    }
    const lists = entries.filter(e => e.isFile() && !e.name.startsWith('~$') && EXCEL_RE.test(e.name) && /zakup/i.test(e.name));
    const xmls = entries.filter(e => e.isDirectory() && /xml/i.test(e.name));
    const pdfs = entries.filter(e => e.isDirectory() && /pdf/i.test(e.name));

    const problems = [];
    const check = (arr, what) => {
        if (arr.length === 0) problems.push(`brak ${what}`);
        else if (arr.length > 1) problems.push(`znaleziono kilka: ${what} (${arr.map(e => e.name).join(', ')})`);
    };
    check(lists, 'pliku Excel z „ZAKUP” w nazwie');
    check(xmls, 'folderu z „XML” w nazwie');
    check(pdfs, 'folderu z „PDF” w nazwie');
    if (problems.length) return { ok: false, error: `W wybranym folderze: ${problems.join('; ')}.` };

    return {
        ok: true, dir,
        inv: path.join(dir, lists[0].name),
        xml: path.join(dir, xmls[0].name),
        pdf: path.join(dir, pdfs[0].name),
    };
}

module.exports = { scanBundle };
