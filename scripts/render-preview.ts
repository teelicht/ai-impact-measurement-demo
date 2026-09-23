import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadSynthetic } from '../src/adapters/synthetic.js';
import { renderHtml } from '../src/html.js';
import { buildReport } from '../src/report.js';

const output = fileURLToPath(new URL('../../output/api-team.html', import.meta.url));
mkdirSync(fileURLToPath(new URL('../../output/', import.meta.url)), { recursive: true });
writeFileSync(output, renderHtml(buildReport(loadSynthetic())), 'utf8');
console.log(output);