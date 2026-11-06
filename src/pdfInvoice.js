const fs = require('fs');
const path = require('path');

// Ścieżka do <dir>/<nr KSEF>.pdf albo null (zły numer, brak folderu, brak pliku).
function pdfPath(dir, ksef) {
    const id = String(ksef ?? '').trim();
    if (!dir || !/^[A-Za-z0-9-]+$/.test(id)) return null;
    const file = path.join(dir, id + '.pdf');
    return fs.existsSync(file) ? file : null;
}

module.exports = { pdfPath };
