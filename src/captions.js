// Caption model + canvas renderer. Shared by the live preview and the video export.

const FONT = "'Inter', system-ui, sans-serif";

export const STYLE_DEFS = {
  pop:     { upper: true,  weight: 900, highlight: 'fill' },
  box:     { upper: true,  weight: 900, highlight: 'box' },
  karaoke: { upper: false, weight: 800, highlight: 'karaoke' },
  clean:   { upper: false, weight: 700, highlight: 'none' },
  neon:    { upper: true,  weight: 900, highlight: 'glow' },
};

/** Group timed words into caption chunks. */
export function buildChunks(words, maxWords = 3) {
  const chunks = [];
  let cur = null;
  for (const w of words) {
    const text = (w.text || '').trim();
    if (!text) continue;
    const word = { text, start: w.start, end: Math.max(w.end, w.start + 0.05) };
    const breakBefore = !cur
      || cur.words.length >= maxWords
      || word.start - cur.end > 0.6
      || word.end - cur.start > 3.2
      || /[.!?…。！？]$/.test(cur.words[cur.words.length - 1].text);
    if (breakBefore) {
      cur = { words: [word], start: word.start, end: word.end };
      chunks.push(cur);
    } else {
      cur.words.push(word);
      cur.end = word.end;
    }
  }
  return chunks;
}

/** Flatten chunks back to words (used when re-grouping after edits). */
export const flatten = (chunks) => chunks.flatMap((c) => c.words);

/** Replace a chunk's text, keeping timings when the word count is unchanged. */
export function retextChunk(chunk, text) {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  if (tokens.length === chunk.words.length) {
    chunk.words = chunk.words.map((w, i) => ({ ...w, text: tokens[i] }));
  } else {
    const dur = Math.max(chunk.end - chunk.start, 0.2 * tokens.length);
    const step = dur / tokens.length;
    chunk.words = tokens.map((t, i) => ({ text: t, start: chunk.start + i * step, end: chunk.start + (i + 1) * step }));
    chunk.end = chunk.start + dur;
  }
  return chunk;
}

export function toSRT(chunks) {
  const ts = (s) => {
    const ms = Math.max(0, Math.round(s * 1000));
    const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
    const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
    const sec = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
    return `${h}:${m}:${sec},${String(ms % 1000).padStart(3, '0')}`;
  };
  return chunks.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.words.map((w) => w.text).join(' ')}\n`).join('\n');
}

function activeChunk(chunks, t) {
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const next = chunks[i + 1];
    const hold = next ? Math.min(next.start, c.end + 0.5) : c.end + 0.5;
    if (t >= c.start && t < hold) return c;
  }
  return null;
}

const easeOutBack = (x) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

/**
 * Draw the captions for time t onto ctx (W×H, the video's pixel size).
 * opts: { style, color, size (0.6–1.5), pos (0.1–0.9), tag }
 */
export function drawCaptions(ctx, W, H, t, chunks, opts) {
  const def = STYLE_DEFS[opts.style] || STYLE_DEFS.pop;
  const base = Math.min(W, H * 0.5625) * 0.075 * opts.size;
  const fs = Math.max(12, Math.round(base));

  if (opts.tag) drawTag(ctx, W, H, fs);

  const chunk = activeChunk(chunks, t);
  if (!chunk) return;

  ctx.save();
  ctx.font = `${def.weight} ${fs}px ${FONT}`;
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  const space = ctx.measureText(' ').width * 1.1;
  const words = chunk.words.map((w) => {
    const text = def.upper ? w.text.toLocaleUpperCase() : w.text;
    return { ...w, text, width: ctx.measureText(text).width };
  });

  // wrap into lines
  const maxW = W * 0.84;
  const lines = [[]];
  let lineW = 0;
  for (const w of words) {
    const add = (lines[lines.length - 1].length ? space : 0) + w.width;
    if (lineW + add > maxW && lines[lines.length - 1].length) { lines.push([w]); lineW = w.width; }
    else { lines[lines.length - 1].push(w); lineW += add; }
  }

  const lh = fs * 1.22;
  const blockH = lines.length * lh;
  const margin = H * 0.06;
  let top = opts.pos * H - blockH / 2;
  top = Math.min(Math.max(top, margin), H - margin - blockH);

  // chunk entrance
  const since = t - chunk.start;
  const enter = def.highlight === 'none' ? 1 : Math.min(1, since / 0.12);
  const blockScale = def.highlight === 'none' ? 1 : 0.92 + 0.08 * easeOutBack(enter);
  const cx = W / 2, cy = top + blockH / 2;
  ctx.translate(cx, cy); ctx.scale(blockScale, blockScale); ctx.translate(-cx, -cy);
  ctx.globalAlpha = 0.6 + 0.4 * enter;

  // active word = last word whose start <= t
  let activeIdx = -1;
  words.forEach((w, i) => { if (t >= w.start) activeIdx = i; });

  let wi = 0;
  lines.forEach((line, li) => {
    const lw = line.reduce((s, w, i) => s + w.width + (i ? space : 0), 0);
    let x = (W - lw) / 2;
    const y = top + li * lh + fs * 0.98;
    for (const w of line) {
      const idx = wi++;
      const status = idx < activeIdx ? 'past' : idx === activeIdx ? 'active' : 'future';
      drawWord(ctx, def, w, x, y, fs, status, t - w.start, opts.color);
      x += w.width + space;
    }
  });
  ctx.restore();
}

function drawWord(ctx, def, w, x, y, fs, status, since, color) {
  const active = status === 'active';
  ctx.save();
  if (def.highlight === 'fill' && active) {
    const p = Math.min(1, since / 0.1);
    const s = 1 + 0.12 * easeOutBack(p) - 0.04 * p;
    const cx = x + w.width / 2, cy = y - fs * 0.35;
    ctx.translate(cx, cy); ctx.scale(s, s); ctx.translate(-cx, -cy);
  }
  switch (def.highlight) {
    case 'fill':
      ctx.lineWidth = fs * 0.2; ctx.strokeStyle = '#000';
      ctx.strokeText(w.text, x, y);
      ctx.fillStyle = active ? color : '#fff';
      ctx.fillText(w.text, x, y);
      break;
    case 'box':
      if (active) {
        const padX = fs * 0.16, padY = fs * 0.12;
        ctx.fillStyle = color;
        roundRect(ctx, x - padX, y - fs * 0.86 - padY, w.width + padX * 2, fs * 1.04 + padY * 2, fs * 0.2);
        ctx.fill();
        ctx.fillStyle = isLight(color) ? '#0d0b16' : '#fff';
        ctx.fillText(w.text, x, y);
      } else {
        ctx.shadowColor = 'rgba(0,0,0,.75)'; ctx.shadowBlur = fs * 0.22; ctx.shadowOffsetY = fs * 0.05;
        ctx.fillStyle = '#fff';
        ctx.fillText(w.text, x, y);
      }
      break;
    case 'karaoke':
      ctx.lineWidth = fs * 0.12; ctx.strokeStyle = 'rgba(0,0,0,.85)';
      ctx.strokeText(w.text, x, y);
      ctx.fillStyle = active ? color : status === 'past' ? '#fff' : 'rgba(255,255,255,.5)';
      ctx.fillText(w.text, x, y);
      break;
    case 'glow':
      if (active) { ctx.shadowColor = color; ctx.shadowBlur = fs * 0.7; ctx.fillStyle = color; }
      else { ctx.lineWidth = fs * 0.1; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.strokeText(w.text, x, y); ctx.fillStyle = '#fff'; }
      ctx.fillText(w.text, x, y);
      if (active) { ctx.shadowBlur = fs * 0.25; ctx.fillText(w.text, x, y); }
      break;
    default: // none
      ctx.shadowColor = 'rgba(0,0,0,.85)'; ctx.shadowBlur = fs * 0.3; ctx.shadowOffsetY = fs * 0.04;
      ctx.fillStyle = '#fff';
      ctx.fillText(w.text, x, y);
  }
  ctx.restore();
}

function drawTag(ctx, W, H, fs) {
  const s = Math.max(10, Math.round(fs * 0.3));
  ctx.save();
  ctx.font = `700 ${s}px ${FONT}`;
  const text = 'wordflare.app';
  const tw = ctx.measureText(text).width;
  const m = Math.round(Math.min(W, H) * 0.035);
  const icon = s * 1.1;
  const x = W - m - tw, y = m + s;
  ctx.globalAlpha = 0.78;
  ctx.fillStyle = '#FFD43B';
  roundRect(ctx, x - icon - s * 0.35, y - icon * 0.82, icon, icon * 0.7, icon * 0.16);
  ctx.fill();
  ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = s * 0.4;
  ctx.fillStyle = '#fff';
  ctx.fillText(text, x, y);
  ctx.restore();
}

function isLight(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 > 150;
}
