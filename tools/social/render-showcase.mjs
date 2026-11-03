import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
mkdirSync('/tmp/showcase/frames', { recursive: true });
const srv = spawn('python3', ['-m', 'http.server', '8777', '-d', '/tmp/showcase'], { stdio: 'ignore' });
const chrome = spawn('google-chrome', ['--headless=new','--no-sandbox','--disable-gpu','--remote-debugging-port=9555','about:blank'], { stdio: 'ignore' });
await sleep(1200);
let ws; for (let i=0;i<50&&!ws;i++){ try{ ws=(await (await fetch('http://127.0.0.1:9555/json/version')).json()).webSocketDebuggerUrl }catch{ await sleep(200) } }
const sock = new WebSocket(ws); await new Promise(r=>sock.addEventListener('open',r,{once:true}));
let id=0; const pend=new Map(); sock.addEventListener('message',e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id)}});
const send=(method,params={},sessionId)=>new Promise(r=>{const i=++id;pend.set(i,r);sock.send(JSON.stringify({id:i,method,params,sessionId}))});
const {result:{targetId}}=await send('Target.createTarget',{url:'http://localhost:8777/index.html'});
const {result:{sessionId}}=await send('Target.attachToTarget',{targetId,flatten:true});
const ev = async (e) => (await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true},sessionId)).result?.result?.value;
for (let i=0;i<50;i++){ if (await ev('window.READY===true')) break; await sleep(200); }
const n = await ev('window.TOTAL_FRAMES');
for (let i=0;i<n;i++){ const d = await ev(`renderFrame(${i})`); writeFileSync(`/tmp/showcase/frames/f${String(i).padStart(4,'0')}.jpg`, Buffer.from(d.split(',')[1],'base64')); }
console.log('frames', n); chrome.kill(); srv.kill(); process.exit(0);
