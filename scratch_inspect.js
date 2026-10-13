const J = require('jszip'), fs = require('fs');
J.loadAsync(fs.readFileSync('Dane/oryginal-only-copy/Kopia październik 2026.xlsx')).then(async z => {
    console.log(Object.keys(z.files).join(','));
    console.log((await z.file('xl/workbook.xml').async('string')).slice(0, 1200));
    console.log(await z.file('xl/_rels/workbook.xml.rels').async('string'));
    const s = await z.file('xl/worksheets/sheet1.xml').async('string');
    for (const r of [6, 50]) {
        const i = s.indexOf('<row r="' + r + '"');
        console.log(s.slice(i, i + 1600), '\n----');
    }
});
