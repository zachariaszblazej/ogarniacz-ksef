const fs = require('fs');
const path = require('path');

// Znaczniki netto pod <Fa>: P_13_1 .. P_13_11 bez samego P_13_6 (ale z P_13_6_1..3); brak któregoś znacznika to nie błąd
const NET_TAGS = ['P_13_1', 'P_13_2', 'P_13_3', 'P_13_4', 'P_13_5', 'P_13_6_1', 'P_13_6_2', 'P_13_6_3',
    'P_13_7', 'P_13_8', 'P_13_9', 'P_13_10', 'P_13_11'];
// Znaczniki VAT pod <Fa>
const VAT_TAGS = ['P_14_1', 'P_14_2', 'P_14_3', 'P_14_4', 'P_14_5'];

// "56.43" / "-1,5" -> grosze (liczba całkowita), bez float. null gdy to nie jest kwota dziesiętna.
function decimalToCents(text) {
    const m = /^([+-]?)(\d+)(?:[.,](\d+))?$/.exec(String(text).trim());
    if (!m) return null;
    const frac = (m[3] || '').padEnd(2, '0');
    // więcej niż 2 miejsca po przecinku: zaokrąglenie do groszy
    let cents = parseInt(m[2], 10) * 100 + parseInt(frac.slice(0, 2), 10);
    if (frac.length > 2 && frac.charCodeAt(2) >= 53) cents += 1; // '5' = 53
    return m[1] === '-' ? -cents : cents;
}

function sumTags(faXml, tags) {
    let sum = 0;
    for (const tag of tags) {
        const re = new RegExp(`<(?:[\\w.-]+:)?${tag}>\\s*([^<]*?)\\s*</(?:[\\w.-]+:)?${tag}>`, 'g');
        for (const m of faXml.matchAll(re)) {
            const c = decimalToCents(m[1]);
            if (c === null) throw new Error(`Nieprawidłowa kwota w znaczniku ${tag}: „${m[1]}”`);
            sum += c;
        }
    }
    return sum;
}

// Czyta kwoty netto i VAT (w groszach, nieujemne) z pliku <dir>/<nr KSEF>.xml.
// Zwraca { net, vat } albo { error }.
function readAmounts(dir, ksef) {
    try {
        const id = String(ksef ?? '').trim();
        if (!dir) return { error: 'nie podano folderu z XML' };
        if (!/^[A-Za-z0-9-]+$/.test(id)) return { error: 'nieprawidłowy numer KSEF' };
        const file = path.join(dir, id + '.xml');
        if (!fs.existsSync(file)) return { error: `brak pliku ${id}.xml` };
        const xml = fs.readFileSync(file, 'utf8');
        const fa = /<(?:[\w.-]+:)?Fa(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?Fa>/.exec(xml);
        if (!fa) return { error: 'w pliku XML nie znaleziono sekcji <Fa>' };
        // kwoty ze znakiem (korekty mogą mieć wartości ujemne)
        return { net: sumTags(fa[1], NET_TAGS), vat: sumTags(fa[1], VAT_TAGS) };
    } catch (e) {
        return { error: e.message };
    }
}

module.exports = { readAmounts, decimalToCents };
