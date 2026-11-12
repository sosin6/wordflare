const { chromium } = require('playwright');
(async()=>{
  const dir=process.argv[2];
  const b=await chromium.launch(); const p=await b.newPage({viewport:{width:1080,height:1350},deviceScaleFactor:1});
  await p.goto('file://'+dir+'/w2-slides.html'); await p.waitForTimeout(500);
  const names={a:'carrusel-A-3-errores',b:'carrusel-B-30-segundos'};
  for(const id of await p.$$eval('section',s=>s.map(x=>x.id))){
    const el=await p.$('#'+id);
    await el.screenshot({path:`${dir}/out/${names[id[0]]}/${id[1]}.png`});
  }
  await b.close();
})();
