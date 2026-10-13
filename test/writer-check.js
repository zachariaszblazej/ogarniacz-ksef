const fs = require('fs'), os = require('os'), path = require('path');
const { run } = require('../src/matcher');
const { applyPlan } = require('../src/writer');
const XLSX = require('xlsx');

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksef-'));
    const led = path.join(dir, 'ewidencja.xlsx');
    fs.copyFileSync('Dane/oryginal-only-copy/Kopia październik 2026.xlsx', led);
    const inv = 'Dane/oryginal-only-copy/ZAKUP_Październik 2026.xlsx';
    const r1 = await run(inv, led);
    const todo = r1.plan.filter(p => p.hasChanges);
    console.log('matched', r1.matched.length, 'do zmiany', todo.length);
    const res = await applyPlan(led, r1.plan);
    console.log('zapis', res.changedRecords, path.basename(res.backup));
    const ws = XLSX.readFile(led, { cellDates: true }).Sheets['Październik (O)'];
    const p = todo[0];
    for (const c of ['B', 'C', 'F']) console.log(c + p.row, ws[c + p.row].v, ws[c + p.row].t);
    const r2 = await run(inv, led);
    console.log('po zapisie: do zmiany', r2.plan.filter(x => x.hasChanges).length, 'matched', r2.matched.length);
    console.log(JSON.stringify(todo.find(x => x.c.old), null, 0));
})().catch(e => console.log('ERR', e.stack));
