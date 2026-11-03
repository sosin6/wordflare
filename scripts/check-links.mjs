// Verifies every internal link/asset referenced from dist/*.html exists. No dependencies.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const exists = (p) => {
  const f = join(DIST, p);
  if (existsSync(f) && statSync(f).isFile()) return true;
  return existsSync(join(f, 'index.html'));
};

let bad = 0;
for (const file of walk(DIST).filter((f) => f.endsWith('.html'))) {
  const html = readFileSync(file, 'utf8');
  for (const [, url] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    if (/^(https?:|mailto:|#|data:)/.test(url)) continue;
    const path = url.split(/[?#]/)[0];
    if (!exists(path)) { bad++; console.error(`Broken: ${url} in ${file.replace(DIST, '')}`); }
  }
}
if (bad) { console.error(`${bad} broken link(s)`); process.exit(1); }
console.log('All internal links OK');
