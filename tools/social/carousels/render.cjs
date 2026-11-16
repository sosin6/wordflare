// node render.js <outDir> [slides.html]  (default w2-slides.html)
// Each <section> is saved as <outDir>/out/<data-set or legacy name>/<n>.png
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
(async()=>{
  const dir=path.resolve(process.argv[2]); const file=process.argv[3]||'w2-slides.html';
  const b=await chromium.launch(); const p=await b.newPage({viewport:{width:1080,height:1350},deviceScaleFactor:1});
  await p.goto('file://'+path.join(__dirname,file)); await p.waitForTimeout(500);
  const legacy={a:'carrusel-A-3-errores',b:'carrusel-B-30-segundos'};
  for(const s of await p.$$eval('section',s=>s.map(x=>({id:x.id,set:x.dataset.set})))){
    const out=path.join(dir,'out',s.set||legacy[s.id[0]]); fs.mkdirSync(out,{recursive:true});
    await (await p.$('#'+s.id)).screenshot({path:`${out}/${s.id.slice(1)}.png`});
  }
  await b.close();
})();
