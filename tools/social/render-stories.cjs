// node tools/social/render-stories.cjs <outDir>  → one PNG per <section id> of stories.html (1080x1920)
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
(async () => {
  const out = path.resolve(process.argv[2] || '/tmp/stories'); fs.mkdirSync(out, { recursive: true });
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1080, height: 1920 } });
  await p.goto('file://' + path.join(__dirname, 'stories.html')); await p.waitForTimeout(500);
  for (const id of await p.$$eval('section', s => s.map(x => x.id))) await (await p.$('#' + id)).screenshot({ path: path.join(out, id + '.png') });
  await b.close();
})();
