// Assemble test/preview.html: real du-core.js + real css + scan output.
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tsv = readFileSync(join(here, 'out', 'lastscan.tsv'), 'utf8');
let status = {};
try { status = JSON.parse(readFileSync(join(here, 'out', 'status.json'), 'utf8')); } catch (e) {}

let tpl = readFileSync(join(here, 'preview.template.html'), 'utf8');
tpl = tpl
    .replace('__TSV_DATA__', tsv.replace(/<\/script/gi, '<\\/script'))
    .replace('__ROOT__', String(status.root || ''))
    .replace('__STATUS__', JSON.stringify(status));

writeFileSync(join(here, 'preview.html'), tpl);
const kb = Math.round(statSync(join(here, 'preview.html')).size / 1024);
console.log(`preview.html: ${kb} KB (status: ${status.state || '?'})`);
