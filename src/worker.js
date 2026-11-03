// Speech-to-text worker. Runs Whisper (word timestamps) fully in the browser via transformers.js.
let asr = null;
let device = null;
let cancelled = false;
const files = new Map();
let maxProgress = 0;

async function hasWebGPU() {
  try {
    if (!self.navigator?.gpu) return false;
    const adapter = await self.navigator.gpu.requestAdapter();
    return !!adapter;
  } catch { return false; }
}

function onProgress(p) {
  if (p.status === 'progress' && p.file) {
    files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
    let loaded = 0, total = 0;
    for (const f of files.values()) { loaded += f.loaded; total += f.total; }
    // New files keep appearing while downloading, so never let the bar go backwards.
    if (total > 0) {
      maxProgress = Math.max(maxProgress, Math.min(0.99, loaded / total) * Math.min(1, files.size / 4));
      self.postMessage({ type: 'download', progress: maxProgress });
    }
  } else if (p.status === 'ready') {
    self.postMessage({ type: 'loading' });
  }
}

async function load(modelId, libUrl) {
  if (asr) return;
  const { pipeline, env } = await import(libUrl);
  env.allowLocalModels = false;
  const gpu = await hasWebGPU();
  const attempts = [
    ...(gpu ? [{ device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } }] : []),
    { device: 'wasm', dtype: 'q8' },
    { device: 'wasm', dtype: 'fp32' },
  ];
  let lastErr;
  for (const opt of attempts) {
    try {
      asr = await pipeline('automatic-speech-recognition', modelId, { ...opt, progress_callback: onProgress });
      device = opt.device;
      return;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('model load failed');
}

function rms(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i += 4) s += arr[i] * arr[i];
  return Math.sqrt(s / Math.max(1, arr.length / 4));
}

async function transcribe(audio, language) {
  const SR = 16000, LEN = 30 * SR, STEP = 27 * SR;
  const words = [];
  const total = Math.max(1, Math.ceil(Math.max(0, audio.length - (LEN - STEP)) / STEP));
  let lastEnd = -1;
  for (let i = 0, k = 0; i < audio.length; i += STEP, k++) {
    if (cancelled) return null;
    const seg = audio.subarray(i, Math.min(audio.length, i + LEN));
    const offset = i / SR;
    self.postMessage({ type: 'transcribe', progress: k / total });
    if (seg.length < SR * 0.3 || rms(seg) < 0.003) { if (i + LEN >= audio.length) break; continue; }
    const opts = { return_timestamps: 'word', task: 'transcribe' };
    if (language) opts.language = language;
    const out = await asr(seg, opts);
    for (const c of out?.chunks || []) {
      const text = (c.text || '').trim();
      if (!text || !c.timestamp) continue;
      const start = (c.timestamp[0] ?? 0) + offset;
      const end = (c.timestamp[1] ?? c.timestamp[0] + 0.3) + offset;
      if (start < lastEnd - 0.1) continue; // overlap between windows
      words.push({ text, start, end: Math.max(end, start + 0.05) });
      lastEnd = end;
    }
    if (i + LEN >= audio.length) break;
  }
  self.postMessage({ type: 'transcribe', progress: 1 });
  return words;
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'cancel') { cancelled = true; return; }
  if (msg.type !== 'run') return;
  cancelled = false;
  try {
    await load(msg.modelId, msg.libUrl);
    self.postMessage({ type: 'loading' });
    const words = await transcribe(msg.audio, msg.language);
    if (words) self.postMessage({ type: 'result', words, device });
  } catch (err) {
    self.postMessage({ type: 'error', stage: asr ? 'transcribe' : 'model', message: String(err?.message || err).slice(0, 200) });
  }
};
