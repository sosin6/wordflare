// Renders tools/social/reels-w3.html to MP4s: node tools/social/render-reels.mjs <outDir> [sound mistakes how]
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const out = path.resolve(process.argv[2] || '/tmp/reels-w3');
const names = process.argv.slice(3).length ? process.argv.slice(3) : ['sound', 'mistakes', 'how'];
const serve = path.join(out, 'serve'); mkdirSync(serve, { recursive: true });
copyFileSync(path.join(root, 'src/captions.js'), path.join(serve, 'captions.js'));
copyFileSync(path.join(root, 'tools/social/reels-w3.html'), path.join(serve, 'index.html'));
const srv = spawn('python3', ['-m', 'http.server', '8778', '-d', serve], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 800));
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1080, height: 1920 } });
for (const n of names) {
  const fr = path.join(out, 'frames-' + n); rmSync(fr, { recursive: true, force: true }); mkdirSync(fr, { recursive: true });
  await p.goto('http://localhost:8778/index.html?r=' + n); await p.waitForFunction('window.READY===true');
  const total = await p.evaluate('window.TOTAL_FRAMES');
  for (let i = 0; i < total; i++) { const d = await p.evaluate(`renderFrame(${i})`); writeFileSync(path.join(fr, `f${String(i).padStart(4, '0')}.jpg`), Buffer.from(d.split(',')[1], 'base64')); }
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', '30', '-i', path.join(fr, 'f%04d.jpg'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', path.join(out, `reel-${n}.mp4`)]);
  console.log(n, total, 'frames');
}
await b.close(); srv.kill();
