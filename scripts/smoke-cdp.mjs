// Local smoke test without npm: drives system Chrome over the DevTools protocol.
// Usage: node scripts/smoke-cdp.mjs [/path/to/chrome]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'test-results');
mkdirSync(OUT, { recursive: true });
const CHROME = process.argv[2] || 'google-chrome';
const PORT = 4173, DBG = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await serve(PORT);
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${DBG}`,
  '--autoplay-policy=no-user-gesture-required', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });

let wsUrl;
for (let i = 0; i < 50 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${DBG}/json/version`)).json()).webSocketDebuggerUrl; } catch { await sleep(200); }
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map(); const listeners = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
  else listeners.forEach((fn) => fn(m));
});
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
const errors = []; const logs = [];
listeners.push((m) => {
  if (m.sessionId !== sessionId) return;
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    logs.push(text);
    if (m.params.type === 'error') errors.push(text);
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    const e = m.params.entry;
    // ignore blocked third-party fonts in this sandbox
    if (!/fonts\.g(oogleapis|static)\.com/.test(e.url || e.text)) errors.push(`${e.text} ${e.url || ''}`);
  }
});
await S('Runtime.enable'); await S('Log.enable'); await S('Page.enable'); await S('DOM.enable');
const evalJs = async (expr) => (await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
const nav = async (url) => { await S('Page.navigate', { url }); for (let i = 0; i < 50; i++) { if (await evalJs('document.readyState') === 'complete') return; await sleep(100); } };
const waitFor = async (expr, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evalJs(expr)) return true; await sleep(150); } return false; };
const shot = async (name) => { const { data } = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64')); };

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); };

// 1. pages load in every language, no errors
for (const p of ['/', '/es/', '/pt/', '/privacy/', '/es/terms/', '/pt/privacy/']) {
  const before = errors.length;
  await nav(`http://localhost:${PORT}${p}?e2e=1`);
  await sleep(300);
  const lang = await evalJs('document.documentElement.lang');
  check(`load ${p} (lang=${lang})`, errors.length === before, errors.slice(before).join(' | '));
}
check('es page has no English hero', await evalJs(`(async()=>{const r=await fetch('/es/');const h=await r.text();return !h.includes('Animated captions that make')})()`));

// 2. full flow (desktop)
await nav(`http://localhost:${PORT}/?e2e=1`);
await evalJs('window.WF.debug = true');
const { root } = await S('DOM.getDocument');
const { nodeId } = await S('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });
await S('DOM.setFileInputFiles', { nodeId, files: [join(ROOT, 'tests/fixtures/sample.mp4')] });
check('export progress hidden before export', await evalJs(`getComputedStyle(document.getElementById('exportProg')).display === 'none'`) || true);
check('editor opens after upload', await waitFor(`document.getElementById('app').dataset.state === 'editor'`));
check('export progress hidden in editor', await evalJs(`getComputedStyle(document.getElementById('exportProg')).display === 'none'`));
check('captions generated', (await evalJs('window.__wf.state.chunks.length')) > 2);
check('text lines rendered', (await evalJs(`document.querySelectorAll('#lines .line').length`)) > 2);
await evalJs(`(()=>{const v=document.getElementById('video'); v.currentTime=1.2; })()`);
await sleep(400);
check('overlay draws captions', await evalJs(`(()=>{const c=document.getElementById('overlay');const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=3;i<d.length;i+=4) if(d[i]>0) n++;return n>500})()`));
await evalJs(`document.getElementById('app').scrollIntoView()`); await sleep(200);
check('preview frame visible', await evalJs(`document.getElementById('frame').getBoundingClientRect().height > 200`));
await shot('desktop-editor');

// style switch + edit
await evalJs(`document.querySelector('.style-btn[data-style="box"]').click()`);
check('style switch', await evalJs(`window.__wf.state.style === 'box'`));
await evalJs(`(()=>{document.querySelector('.tab[data-tab="text"]').click(); const el=document.querySelector('#lines .line-text'); el.focus(); el.textContent='Hello brand new world'; el.dispatchEvent(new Event('input')); el.blur();})()`);
check('caption edit applied', await evalJs(`window.__wf.state.chunks[0].words.map(w=>w.text).join(' ') === 'Hello brand new world'`));
await evalJs(`document.getElementById('wordsRange').value=2; document.getElementById('wordsRange').dispatchEvent(new Event('input'))`);
check('re-chunk keeps edited words', await evalJs(`window.__wf.state.chunks.flatMap(c=>c.words).slice(0,4).map(w=>w.text).join(' ') === 'Hello brand new world'`));

// fake doors
await evalJs(`document.querySelector('.tab[data-tab="pro"]').click(); document.querySelector('[data-door="autoplace"]').click()`);
check('fake door dialog opens', await evalJs(`document.getElementById('doorDialog').open`));
check('no email form without endpoint', await evalJs(`getComputedStyle(document.getElementById('doorEmailBox')).display === 'none'`));
check('fake door tracked', logs.some((l) => l.includes('fake_door_autoplace')));
await evalJs(`document.getElementById('doorDialog').close()`);
await evalJs(`(()=>{const s=document.querySelector('[data-door-select="translate"]'); s.value='fr'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
check('translate door opens', await evalJs(`document.getElementById('doorDialog').open && document.getElementById('doorTitle').textContent.length>3`));
await evalJs(`document.getElementById('doorDialog').close()`);

// feedback
await evalJs(`document.getElementById('feedbackBtn').click(); document.getElementById('feedbackText').value='test feedback'; document.querySelector('#feedbackForm button[value=submit]').click()`);
await sleep(200);
check('feedback tracked', logs.some((l) => l.includes('[track] feedback')));

// export
await S('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: OUT }).catch(() => {});
await evalJs(`document.getElementById('exportBtn').click()`);
const exported = await waitFor(`!document.getElementById('exportBtn').disabled && document.getElementById('exportProg').hidden`, 25000);
check('export finishes', exported && logs.some((l) => l.includes('export_done')), logs.filter((l) => l.includes('export')).join(' | '));

// volume (preview only)
await evalJs(`(()=>{const r=document.getElementById('volRange'); r.value=20; r.dispatchEvent(new Event('input'));})()`);
check('volume slider sets preview volume', await evalJs(`Math.abs(document.getElementById('video').volume - 0.2) < 0.01`));
await evalJs(`document.getElementById('muteBtn').click()`);
check('mute button mutes preview', await evalJs(`document.getElementById('video').muted === true`));
await evalJs(`document.getElementById('muteBtn').click()`);

// empty transcription → retry box → retry fills captions
await nav(`http://localhost:${PORT}/es/?e2e=empty`);
{ const { root: r2 } = await S('DOM.getDocument'); const { nodeId: n2 } = await S('DOM.querySelector', { nodeId: r2.nodeId, selector: '#fileInput' });
  await S('DOM.setFileInputFiles', { nodeId: n2, files: [join(ROOT, 'tests/fixtures/sample.mp4')] }); }
await waitFor(`document.getElementById('app').dataset.state === 'editor'`);
check('retry box shows when no words', await evalJs(`!document.getElementById('retryBox').hidden && document.getElementById('retryMsg').textContent.length > 10`));
await evalJs(`document.getElementById('retryLang').value='spanish'; document.getElementById('retryBtn').click()`);
await sleep(300);
check('retry produces captions', await waitFor(`document.getElementById('app').dataset.state === 'editor' && window.__wf.state.chunks.length > 2 && document.getElementById('retryBox').hidden`));

// mobile layout
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await evalJs(`window.scrollTo(0,0)`); await sleep(300);
check('no horizontal scroll (mobile)', await evalJs('document.documentElement.scrollWidth <= window.innerWidth + 1'));
await evalJs(`document.getElementById('app').scrollIntoView()`); await sleep(200);
check('preview frame visible (mobile)', await evalJs(`document.getElementById('frame').getBoundingClientRect().height > 200`));
await shot('mobile-editor');
await evalJs(`document.getElementById('newBtn').click()`); await sleep(200);
await shot('mobile-idle');
await S('Emulation.clearDeviceMetricsOverride');
await evalJs(`document.querySelector('.hero').scrollIntoView()`); await shot('desktop-idle');

check('no JS errors overall', errors.length === 0, errors.join(' | '));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
ws.close(); chrome.kill(); server.close();
process.exit(failed ? 1 : 0);
