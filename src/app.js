import { CONFIG } from './config.js';
import { initAnalytics, track, reportError } from './analytics.js';
import { initDoors, openDoor } from './doors.js';
import { buildChunks, flatten, retextChunk, toSRT, drawCaptions } from './captions.js';

const WF = window.WF;
const t = WF.t;
const params = new URLSearchParams(location.search);
const E2E = params.has('e2e');
const $ = (id) => document.getElementById(id);

const app = $('app');
const video = $('video');
const overlay = $('overlay');
const octx = overlay.getContext('2d');

const state = {
  file: null, url: null, duration: 0, w: 0, h: 0,
  chunks: [], wordsPer: 3,
  style: 'pop', color: '#FFD43B', size: 1, pos: 0.68, tag: true,
  worker: null, dirty: true, lastT: -1, edited: false, exporting: null,
};

/* ---------------- boot ---------------- */
initAnalytics();
initDoors(t);
track('page_view_app', { lang: WF.lang });

$('langSelect').addEventListener('change', (e) => { location.href = e.target.value + location.hash; });

// Feedback
$('feedbackBtn').addEventListener('click', () => {
  $('feedbackThanks').hidden = true; $('feedbackText').value = ''; $('feedbackDialog').showModal();
});
$('feedbackForm').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'submit') return;
  e.preventDefault();
  const text = $('feedbackText').value.trim();
  if (!text) return;
  track('feedback', { text: text.slice(0, 500), lang: WF.lang, state: app.dataset.state });
  $('feedbackThanks').hidden = false;
  setTimeout(() => $('feedbackDialog').close(), 1400);
});

/* ---------------- spoken language ---------------- */
const WHISPER_LANG = { en: 'english', es: 'spanish', pt: 'portuguese', fr: 'french', de: 'german', it: 'italian', nl: 'dutch', tr: 'turkish', ru: 'russian', pl: 'polish', hi: 'hindi', ar: 'arabic', ja: 'japanese', ko: 'korean', zh: 'chinese', id: 'indonesian' };
function browserLang() {
  for (const l of [...(navigator.languages || []), navigator.language, WF.lang]) {
    const code = String(l || '').slice(0, 2).toLowerCase();
    if (WHISPER_LANG[code]) return WHISPER_LANG[code];
  }
  return null;
}
// Most creators speak their own language: preselect it (they can still pick "detect automatically").
(() => {
  const saved = (() => { try { return localStorage.getItem('wf_spoken'); } catch { return null; } })();
  const sel = $('spokenLang');
  const pick = saved !== null ? saved : browserLang();
  if (pick !== null && [...sel.options].some((o) => o.value === pick)) sel.value = pick;
  sel.addEventListener('change', () => { try { localStorage.setItem('wf_spoken', sel.value); } catch {} });
})();

/* ---------------- file input ---------------- */
const drop = $('drop');
const fileInput = $('fileInput');
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener('change', () => { handleFiles([...fileInput.files]); fileInput.value = ''; });
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('is-over'); }));
drop.addEventListener('drop', (e) => handleFiles([...e.dataTransfer.files]));

function handleFiles(files) {
  hideError();
  const vids = files.filter((f) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name));
  if (!vids.length) { if (files.length) showError(t.errors.notVideo); return; }
  if (vids.length > 1) openDoor('batch', t);
  start(vids[0]);
}

/* ---------------- pipeline ---------------- */
function setBusy(text, progress, indeterminate = false) {
  app.dataset.state = 'busy';
  $('busyText').textContent = text;
  const bar = $('busyBar').parentElement;
  bar.classList.toggle('indet', indeterminate);
  if (progress != null) $('busyBar').style.width = `${Math.round(progress * 100)}%`;
}

async function start(file, langOverride) {
  resetMedia();
  const spoken = langOverride ?? $('spokenLang').value;
  state.file = file;
  state.url = URL.createObjectURL(file);
  setBusy(t.preparing, 0.02, true);
  const t0 = performance.now();
  try {
    await loadVideo(state.url);
  } catch (err) {
    reportError('video_load', err);
    return fail(t.errors.decode);
  }
  track('video_loaded', { duration: Math.round(state.duration), w: state.w, h: state.h, type: file.type || 'unknown', size_mb: Math.round(file.size / 1e6) });
  if (state.duration > CONFIG.MAX_SECONDS + 1) {
    toIdle();
    openDoor('longvideo', t);
    return;
  }

  let audio = null;
  setBusy(t.decoding, 0.04, true);
  try {
    audio = await decodeAudio(file);
    state.debugAudio = { samples: audio.length, seconds: +(audio.length / 16000).toFixed(1) };
  } catch (err) {
    state.debugAudio = { error: `${err?.name}: ${err?.message}` };
    reportError('audio_decode', err);
    track('audio_decode_failed', { type: file.type || file.name.split('.').pop(), err: `${err?.name}: ${err?.message}`.slice(0, 150) });
    audio = null; // no audio track or unsupported codec → captions by hand
  }

  let words = [];
  if (audio) {
    try {
      words = E2E ? (params.get('e2e') === 'empty' && !langOverride ? [] : fakeWords(state.duration)) : await runWhisper(audio, spoken);
    } catch (err) {
      if (err?.cancelled) return;
      reportError(`whisper_${err?.stage || 'run'}`, err);
      track('transcribe_error', { stage: err?.stage || 'run', msg: String(err?.message || err).slice(0, 150) });
      return fail(err?.stage === 'model' ? t.errors.model : t.errors.generic);
    }
  }
  if (app.dataset.state !== 'busy') return; // cancelled
  state.chunks = buildChunks(words, state.wordsPer);
  const empty = !audio ? 'decode' : !words.length ? 'no_words' : null;
  const info = { seconds: Math.round((performance.now() - t0) / 1000), words: words.length, duration: Math.round(state.duration), lang: spoken || `auto:${state.detectedLang || '?'}`, device: state.device || (E2E ? 'e2e' : 'none'), type: file.type || 'unknown' };
  track(empty ? 'transcribe_empty' : 'tool_used', empty ? { ...info, reason: empty } : info);
  enterEditor(empty, spoken);
}

function loadVideo(url) {
  return new Promise((resolve, reject) => {
    const done = () => {
      cleanup();
      state.duration = video.duration || 0;
      state.w = video.videoWidth; state.h = video.videoHeight;
      if (!state.w || !state.h || !isFinite(state.duration)) return reject(new Error('no video dimensions'));
      resolve();
    };
    const err = () => { cleanup(); reject(new Error(`video error ${video.error?.code || ''}`)); };
    const cleanup = () => { video.removeEventListener('loadeddata', done); video.removeEventListener('error', err); };
    video.addEventListener('loadeddata', done, { once: true });
    video.addEventListener('error', err, { once: true });
    video.src = url;
    video.load();
  });
}

async function decodeAudio(file) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(await file.arrayBuffer());
  } finally { try { ctx.close(); } catch {} }
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * 16000)), 16000);
  const src = off.createBufferSource();
  src.buffer = decoded; src.connect(off.destination); src.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);
}

function runWhisper(audio, language) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    state.worker = worker;
    setBusy(t.loadingModel, 0.06, true);
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'debug') { (state.debug ||= []).push(m); return; }
      if (m.type === 'download') setBusy(t.downloading, 0.06 + m.progress * 0.54);
      else if (m.type === 'loading') setBusy(t.loadingModel, 0.62, true);
      else if (m.type === 'transcribe') setBusy(t.transcribing, 0.64 + m.progress * 0.36);
      else if (m.type === 'result') { state.device = m.device; state.detectedLang = m.language; cleanupWorker(); resolve(m.words); }
      else if (m.type === 'error') { cleanupWorker(); reject(Object.assign(new Error(m.message), { stage: m.stage })); }
    };
    worker.onerror = (e) => { cleanupWorker(); reject(Object.assign(new Error(e.message || 'worker error'), { stage: 'model' })); };
    state.rejectWorker = reject;
    worker.postMessage({ type: 'run', audio, language: language || null, hint: browserLang(), modelId: CONFIG.MODEL_ID, libUrl: CONFIG.TRANSFORMERS_URL }, [audio.buffer]);
  });
}

function cleanupWorker() {
  if (state.worker) { state.worker.terminate(); state.worker = null; }
  state.rejectWorker = null;
}

$('cancelBtn').addEventListener('click', () => {
  track('transcribe_cancel');
  if (state.rejectWorker) state.rejectWorker(Object.assign(new Error('cancelled'), { cancelled: true }));
  cleanupWorker();
  toIdle();
});

function fakeWords(duration) {
  const text = 'This is a Wordflare test with animated captions that pop on every single word'.split(' ');
  const step = Math.min(0.45, Math.max(0.2, (duration - 0.2) / text.length));
  return text.map((w, i) => ({ text: w, start: 0.1 + i * step, end: 0.1 + (i + 1) * step - 0.03 })).filter((w) => w.end <= duration);
}

/* ---------------- editor ---------------- */
async function enterEditor(emptyReason, spoken = '') {
  try { await Promise.all(['900', '800', '700'].map((w) => document.fonts.load(`${w} 40px Inter`))); } catch {}
  app.dataset.state = 'editor';
  $('retryBox').hidden = !emptyReason;
  if (emptyReason) { $('retryMsg').textContent = emptyReason === 'decode' ? t.noAudio : t.noSpeech; $('retryLang').value = spoken; }
  const frame = $('frame');
  frame.style.setProperty('--ar', (state.w / state.h).toFixed(4));
  const scale = Math.min(1, 960 / Math.max(state.w, state.h));
  overlay.width = Math.round(state.w * scale);
  overlay.height = Math.round(state.h * scale);
  renderLines();
  selectTab(emptyReason ? 'text' : 'style');
  state.dirty = true;
  requestAnimationFrame(loop);
  app.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function opts() {
  return { style: state.style, color: state.color, size: state.size, pos: state.pos, tag: state.tag };
}

function loop() {
  if (app.dataset.state !== 'editor') return;
  const now = video.currentTime;
  if (state.dirty || now !== state.lastT) {
    octx.clearRect(0, 0, overlay.width, overlay.height);
    drawCaptions(octx, overlay.width, overlay.height, now, state.chunks.map((c) => c._preview || c), opts());
    state.lastT = now; state.dirty = false;
    updateTransport(now);
    highlightLine(now);
  }
  requestAnimationFrame(loop);
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function updateTransport(now) {
  if (!seeking) $('seek').value = state.duration ? Math.round((now / state.duration) * 1000) : 0;
  $('timeLabel').textContent = fmt(now);
}

function togglePlay() {
  if (video.paused) video.play().catch(() => {}); else video.pause();
}
$('playBtn').addEventListener('click', togglePlay);
$('playBig').addEventListener('click', togglePlay);
video.addEventListener('play', () => app.classList.add('is-playing'));
video.addEventListener('pause', () => app.classList.remove('is-playing'));
video.addEventListener('ended', () => app.classList.remove('is-playing'));
let seeking = false;
$('seek').addEventListener('input', (e) => { seeking = true; video.currentTime = (e.target.value / 1000) * state.duration; state.dirty = true; });
$('seek').addEventListener('change', () => { seeking = false; });

// retry transcription (other language / transient failure)
$('retryBtn').addEventListener('click', () => {
  if (!state.file) return;
  track('transcribe_retry', { lang: $('retryLang').value || 'auto' });
  start(state.file, $('retryLang').value);
});

// preview volume (never touches the exported audio)
const volBox = $('volRange').parentElement;
const savedVol = (() => { try { return localStorage.getItem('wf_vol'); } catch { return null; } })();
if (savedVol !== null) $('volRange').value = savedVol;
function applyVolume() {
  const v = $('volRange').value / 100;
  video.volume = v;
  video.muted = v === 0 || volBox.classList.contains('is-muted');
}
$('volRange').addEventListener('input', () => {
  volBox.classList.toggle('is-muted', +$('volRange').value === 0);
  applyVolume();
  try { localStorage.setItem('wf_vol', $('volRange').value); } catch {}
});
$('muteBtn').addEventListener('click', () => { volBox.classList.toggle('is-muted'); applyVolume(); });
applyVolume();

// tabs
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));
function selectTab(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('is-on', b.dataset.tab === name));
  document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('is-on', p.dataset.pane === name));
  if (name === 'pro') track('pro_tab_open');
}

// style controls
$('styleGrid').addEventListener('click', (e) => {
  const b = e.target.closest('.style-btn'); if (!b) return;
  state.style = b.dataset.style; state.dirty = true;
  document.querySelectorAll('.style-btn').forEach((x) => { x.classList.toggle('is-on', x === b); x.setAttribute('aria-pressed', x === b); });
  track('style_change', { style: state.style });
});
$('swatches').addEventListener('click', (e) => {
  const b = e.target.closest('.swatch'); if (!b) return;
  state.color = b.dataset.color; state.dirty = true;
  document.documentElement.style.setProperty('--hl', state.color);
  document.querySelectorAll('.swatch').forEach((x) => { x.classList.toggle('is-on', x === b); x.setAttribute('aria-pressed', x === b); });
  track('color_change', { color: state.color });
});
$('sizeRange').addEventListener('input', (e) => { state.size = e.target.value / 100; state.dirty = true; });
$('posRange').addEventListener('input', (e) => { state.pos = e.target.value / 100; state.dirty = true; });
$('wordsRange').addEventListener('input', (e) => {
  state.wordsPer = +e.target.value; $('wordsOut').textContent = state.wordsPer;
  state.chunks = buildChunks(flatten(state.chunks), state.wordsPer);
  renderLines(); state.dirty = true;
});
$('tagCheck').addEventListener('change', (e) => { state.tag = e.target.checked; state.dirty = true; track(state.tag ? 'tag_on' : 'tag_off'); });

/* ---------------- text editing ---------------- */
let activeLine = -1;
function renderLines() {
  const ol = $('lines');
  ol.innerHTML = '';
  state.chunks.forEach((c, i) => {
    const li = document.createElement('li');
    li.className = 'line';
    li.dataset.i = i;
    const time = document.createElement('button');
    time.type = 'button'; time.className = 'line-time'; time.textContent = fmt(c.start);
    time.addEventListener('click', () => { video.currentTime = c.start + 0.01; state.dirty = true; });
    const txt = document.createElement('div');
    txt.className = 'line-text'; txt.contentEditable = 'true'; txt.spellcheck = true;
    txt.textContent = c.words.map((w) => w.text).join(' ');
    txt.addEventListener('focus', () => { video.pause(); video.currentTime = c.start + 0.01; state.dirty = true; });
    txt.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); txt.blur(); } });
    txt.addEventListener('blur', () => commitLine(c, txt.textContent));
    txt.addEventListener('input', () => { const copy = { ...c, words: c.words.map((w) => ({ ...w })) }; if (retextChunk(copy, txt.textContent)) { previewEdit(c, copy); } });
    li.append(time, txt);
    ol.appendChild(li);
  });
  activeLine = -1;
}

function previewEdit(orig, copy) { orig._preview = copy; state.dirty = true; }

function commitLine(chunk, text) {
  delete chunk._preview;
  const idx = state.chunks.indexOf(chunk);
  if (idx < 0) return;
  const before = chunk.words.map((w) => w.text).join(' ');
  if (text.trim() === before) return;
  if (!retextChunk(chunk, text)) state.chunks.splice(idx, 1);
  if (!state.edited) { state.edited = true; track('caption_edit'); }
  renderLines(); state.dirty = true;
}

function highlightLine(now) {
  const idx = state.chunks.findIndex((c, i) => now >= c.start && now < (state.chunks[i + 1]?.start ?? c.end + 0.5));
  if (idx === activeLine) return;
  const ol = $('lines');
  ol.querySelector('.line.is-active')?.classList.remove('is-active');
  const li = ol.querySelector(`.line[data-i="${idx}"]`);
  if (li) {
    li.classList.add('is-active');
    if (document.activeElement?.closest('.line') == null && ol.offsetParent) li.scrollIntoView({ block: 'nearest' });
  }
  activeLine = idx;
}

$('addLine').addEventListener('click', () => {
  const at = video.currentTime;
  const chunk = { start: at, end: Math.min(state.duration, at + 1.5), words: [{ text: '…', start: at, end: Math.min(state.duration, at + 1.5) }] };
  let i = state.chunks.findIndex((c) => c.start > at);
  if (i < 0) i = state.chunks.length;
  state.chunks.splice(i, 0, chunk);
  // keep neighbours from overlapping
  if (state.chunks[i + 1] && chunk.end > state.chunks[i + 1].start) { chunk.end = state.chunks[i + 1].start; chunk.words[0].end = chunk.end; }
  renderLines();
  const el = $('lines').querySelector(`.line[data-i="${i}"] .line-text`);
  if (el) { el.focus(); document.getSelection().selectAllChildren(el); }
  track('caption_add');
});

/* ---------------- export ---------------- */
function pickMime() {
  if (!window.MediaRecorder) return null;
  const ok = (m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } };
  // H.264 in MP4 plays everywhere (iPhone, Instagram, TikTok). Only claim MP4 when H.264 is really available.
  const h264 = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.4d0028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2'].find(ok);
  if (h264) return h264;
  // Safari records H.264 for plain "video/mp4" and has no WebM recorder.
  if (ok('video/mp4') && !ok('video/webm')) return 'video/mp4';
  return ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(ok) || null;
}

$('srtBtn').addEventListener('click', () => {
  download(new Blob([toSRT(state.chunks)], { type: 'text/plain' }), `${baseName()}.srt`);
  track('srt_download', { chunks: state.chunks.length });
});

$('exportBtn').addEventListener('click', () => exportVideo().catch((err) => {
  reportError('export', err);
  track('export_error', { msg: String(err?.message || err).slice(0, 150) });
  endExport();
  showToast(t.errors.generic);
}));
$('exportCancel').addEventListener('click', () => { if (state.exporting) state.exporting.cancel(); });

async function exportVideo() {
  const mime = pickMime();
  if (!mime || !HTMLCanvasElement.prototype.captureStream) { showToast(t.exportUnsupported); track('export_unsupported'); return; }
  video.pause();
  const v = document.createElement('video');
  v.playsInline = true; v.preload = 'auto'; v.src = state.url;
  Object.assign(v.style, { position: 'fixed', left: '-10px', top: '0', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none' });
  document.body.appendChild(v);
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  ac.resume().catch(() => {});

  $('exportBtn').disabled = true;
  $('exportProg').hidden = false;
  $('exportText').textContent = t.exporting;
  $('exportBar').style.width = '0%';
  track('export_start', { style: state.style, duration: Math.round(state.duration), mime: mime.split(';')[0] });

  await new Promise((res, rej) => {
    if (v.readyState >= 2) return res();
    v.addEventListener('loadeddata', res, { once: true });
    v.addEventListener('error', () => rej(new Error('export video load')), { once: true });
  });

  const scale = Math.min(1, 1920 / Math.max(v.videoWidth, v.videoHeight));
  const W = Math.round((v.videoWidth * scale) / 2) * 2;
  const H = Math.round((v.videoHeight * scale) / 2) * 2;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const o = opts();

  const stream = canvas.captureStream(30);
  try {
    const src = ac.createMediaElementSource(v);
    const dest = ac.createMediaStreamDestination();
    src.connect(dest);
    dest.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr));
  } catch (err) { reportError('export_audio', err); }

  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10_000_000, audioBitsPerSecond: 160_000 });
  const parts = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };

  let cancelled = false;
  const draw = (time) => {
    ctx.drawImage(v, 0, 0, W, H);
    drawCaptions(ctx, W, H, time, state.chunks, o);
    $('exportBar').style.width = `${Math.min(100, (time / state.duration) * 100).toFixed(1)}%`;
  };
  const useRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  const tick = (now, meta) => {
    if (cancelled || v.ended) return;
    draw(meta ? meta.mediaTime : v.currentTime);
    if (useRVFC) v.requestVideoFrameCallback(tick); else requestAnimationFrame(() => tick());
  };

  const finished = new Promise((resolve) => {
    v.addEventListener('ended', () => { draw(v.duration); setTimeout(() => rec.state !== 'inactive' && rec.stop(), 150); }, { once: true });
    rec.onstop = resolve;
  });
  state.exporting = {
    cancel: () => { cancelled = true; v.pause(); if (rec.state !== 'inactive') rec.stop(); track('export_cancel'); },
  };

  v.currentTime = 0;
  draw(0);
  rec.start(500);
  try {
    await v.play();
  } catch (err) {
    cancelled = true; if (rec.state !== 'inactive') rec.stop();
    cleanupExport(v, ac); endExport();
    throw err;
  }
  if (useRVFC) v.requestVideoFrameCallback(tick); else requestAnimationFrame(() => tick());

  const t0 = performance.now();
  await finished;
  cleanupExport(v, ac);
  if (cancelled) { endExport(); return; }

  const type = mime.split(';')[0];
  const ext = type.includes('mp4') ? 'mp4' : 'webm';
  const blob = new Blob(parts, { type });
  download(blob, `${baseName()}-wordflare.${ext}`);
  track('export_done', { mime: type, seconds: Math.round((performance.now() - t0) / 1000), size_mb: Math.round(blob.size / 1e6), style: state.style, tag: state.tag });
  endExport();
  showToast(ext === 'webm' ? t.exportWebm : t.exportDone, ext === 'webm' ? 7000 : 3500);
}

function cleanupExport(v, ac) {
  try { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); } catch {}
  try { ac.close(); } catch {}
}
function endExport() {
  state.exporting = null;
  $('exportBtn').disabled = false;
  $('exportProg').hidden = true;
}

/* ---------------- misc ---------------- */
$('newBtn').addEventListener('click', () => { track('new_video'); toIdle(); });

function toIdle() {
  resetMedia();
  app.dataset.state = 'idle';
}
function resetMedia() {
  if (state.exporting) state.exporting.cancel();
  cleanupWorker();
  video.pause();
  if (state.url) { URL.revokeObjectURL(state.url); state.url = null; }
  video.removeAttribute('src'); video.load();
  state.chunks = []; state.edited = false; state.device = null; state.debug = []; state.debugAudio = null;
  app.classList.remove('is-playing');
}
function fail(message) { toIdle(); showError(message); }
function showError(msg) { const el = $('appError'); el.textContent = msg; el.hidden = false; }
function hideError() { $('appError').hidden = true; }

let toastTimer;
function showToast(msg, ms = 3500) {
  const el = $('toast');
  el.textContent = msg; el.classList.add('is-on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('is-on'), ms);
}

function baseName() {
  return (state.file?.name || 'video').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '-').slice(0, 40) || 'video';
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

// expose for tests
window.__wf = { state, openDoor: (f) => openDoor(f, t) };
