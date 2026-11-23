// Publishes approved, due items from content/instagram/queue.json to Instagram
// using the official Instagram Graph API (Facebook Login, system-user token).
//
//   node scripts/ig-publish.mjs            publish what is due (used by .github/workflows/instagram.yml)
//   node scripts/ig-publish.mjs --check    verify the token and show the connected account (no posting)
//   node scripts/ig-publish.mjs --validate check the queue and local media files (no network)
//   node scripts/ig-publish.mjs --audio    list the trending music the Audio API offers this account
//
// Reels can carry Instagram library music (Audio API, Facebook Login only): queue item
// "music": "trending" (top trending track not used in the last 10 posts), {"search": "..."} or
// {"audio_id": "..."}; optional "video_volume" (0-100, default 0 = only the song) and "music_volume".
// If attaching music fails, the Reel is still published without it and the error is logged.
//
// Env: IG_ACCESS_TOKEN (required for --check / publish), IG_USER_ID (optional, auto-discovered),
//      GRAPH_VERSION (default v24.0), SITE (default https://wordflare.app), NOW (ISO, for tests).
// State of what was already posted lives in content/instagram/published.json (committed by the workflow).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const QUEUE = path.join(ROOT, 'content/instagram/queue.json');
const STATE = path.join(ROOT, 'content/instagram/published.json');
const SITE = (process.env.SITE || 'https://wordflare.app').replace(/\/$/, '');
const GV = process.env.GRAPH_VERSION || 'v24.0';
const API = process.env.GRAPH_API || `https://graph.facebook.com/${GV}`;
const TOKEN = process.env.IG_ACCESS_TOKEN || '';
const NOW = process.env.NOW ? new Date(process.env.NOW) : new Date();
const FEED_GAP_H = 20;      // never two feed posts closer than this (spreads a backlog one per day)
const MAX_STORIES = 3;      // per run
const mode = process.argv[2] || '';

const FEED = new Set(['REELS', 'CAROUSEL', 'IMAGE']);
const TYPES = new Set([...FEED, 'STORY']);
const isVideo = p => /\.(mp4|mov)$/i.test(p);

const queue = JSON.parse(readFileSync(QUEUE, 'utf8'));
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const saveState = () => writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');

function validate() {
  const ids = new Set(); const errs = [];
  for (const it of queue) {
    const tag = it.id || '(no id)';
    if (!it.id || ids.has(it.id)) errs.push(`${tag}: missing or duplicate id`); ids.add(it.id);
    if (!TYPES.has(it.type)) errs.push(`${tag}: bad type ${it.type}`);
    if (isNaN(new Date(it.at))) errs.push(`${tag}: bad date`);
    if (!Array.isArray(it.media) || !it.media.length) errs.push(`${tag}: no media`);
    for (const m of it.media || []) {
      if (!existsSync(path.join(ROOT, 'public', m))) errs.push(`${tag}: missing public/${m}`);
      if (!isVideo(m) && !/\.jpe?g$/i.test(m)) errs.push(`${tag}: images must be JPEG (${m})`);
    }
    if (it.type === 'CAROUSEL' && (it.media.length < 2 || it.media.length > 10)) errs.push(`${tag}: carousel needs 2-10 items`);
    if (it.type === 'REELS' && !isVideo(it.media[0])) errs.push(`${tag}: reel needs a video`);
    if (it.type !== 'STORY' && (it.caption || '').length > 2200) errs.push(`${tag}: caption > 2200`);
  }
  return errs;
}

async function g(method, p, params = {}) {
  const url = new URL(API + p); const body = new URLSearchParams({ ...params, access_token: TOKEN });
  const opt = { method };
  if (method === 'GET') { for (const [k, v] of body) url.searchParams.set(k, v); } else opt.body = body;
  const r = await fetch(url, opt); const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`${method} ${p}: ${j.error?.message || r.status}${j.error ? ` (code ${j.error.code}${j.error.error_subcode ? "/" + j.error.error_subcode : ""}${j.error.type ? ", " + j.error.type : ""})` : ""}`);
  return j;
}

async function igUserId() {
  if (process.env.IG_USER_ID) return process.env.IG_USER_ID;
  const j = await g('GET', '/me/accounts', { fields: 'name,instagram_business_account{id,username}' });
  const page = (j.data || []).find(p => p.instagram_business_account);
  if (!page) throw new Error('No Facebook Page with a linked Instagram professional account is visible to this token.');
  return page.instagram_business_account.id;
}

async function waitReady(id) {
  for (let i = 0; i < 40; i++) {           // up to ~10 min for video processing
    const j = await g('GET', '/' + id, { fields: 'status_code,status' });
    if (j.status_code === 'FINISHED') return;
    if (j.status_code === 'ERROR' || j.status_code === 'EXPIRED') throw new Error(`container ${id}: ${j.status_code} ${j.status || ''}`);
    await new Promise(r => setTimeout(r, 15000));
  }
  throw new Error(`container ${id}: timeout`);
}

async function assertPublic(m) {
  const r = await fetch(`${SITE}/${m}`, { method: 'HEAD' });
  if (!r.ok) throw new Error(`media not live yet: ${SITE}/${m} (${r.status})`);
}

const trackInfo = a => ({ audio_id: String(a.id || a.audio_id || a.audio_asset_id || ''), title: a.title || a.name || a.song_name || '', artist: a.display_artist || a.artist || a.artist_name || '' });

async function listAudio(ig, search) {
  const p = { audio_type: 'music', user_id: ig }; if (search) p.search_query = search;
  const j = await g('GET', '/ig_audio', p);
  return (j.audio || j.data || []).map(a => ({ ...trackInfo(a), raw: a })).filter(a => a.audio_id);
}

async function pickAudio(ig, it) {
  const m = it.music; if (!m) return null;
  if (m.audio_id) return { audio_id: String(m.audio_id), title: m.title || '', artist: m.artist || '' };
  const recent = new Set(Object.values(state).filter(s => s && s.audio_id).sort((a, b) => (b.published_at || '').localeCompare(a.published_at || '')).slice(0, 10).map(s => s.audio_id));
  // The Audio API sometimes answers with an empty list: retry, then fall back to broad searches.
  let list = [];
  const tries = [m.search || '', m.search || '', 'pop', 'upbeat', 'dance'];
  for (let i = 0; i < tries.length && !list.length; i++) {
    if (i) await new Promise(r => setTimeout(r, 4000));
    list = await listAudio(ig, tries[i]).catch(e => { console.error(`audio search "${tries[i]}": ${e.message}`); return []; });
  }
  const t = list.find(a => !recent.has(a.audio_id)) || list[0];
  if (!t) throw new Error('Audio API returned no tracks (after retries)');
  return { audio_id: t.audio_id, title: t.title, artist: t.artist };
}

async function publish(ig, it) {
  for (const m of it.media) await assertPublic(m);
  const u = m => `${SITE}/${m}`; let cid;
  let music = null, music_error = null;
  if (it.type === 'REELS') {
    const base = { media_type: 'REELS', video_url: u(it.media[0]), caption: it.caption || '', share_to_feed: 'true' };
    if (it.music) {
      try {
        music = await pickAudio(ig, it);
        const conf = { audio_id: music.audio_id, audio_volume: it.music_volume ?? 100, video_volume: it.video_volume ?? 0 };
        cid = (await g('POST', `/${ig}/media`, { ...base, audio_configuration: JSON.stringify(conf) })).id;
      } catch (e) { music_error = e.message; music = null; console.error(`music skipped for ${it.id}: ${e.message}`); }
    }
    if (!cid) cid = (await g('POST', `/${ig}/media`, base)).id;
  } else if (it.type === 'IMAGE') {
    cid = (await g('POST', `/${ig}/media`, { image_url: u(it.media[0]), caption: it.caption || '' })).id;
  } else if (it.type === 'STORY') {
    const m = it.media[0];
    cid = (await g('POST', `/${ig}/media`, isVideo(m) ? { media_type: 'STORIES', video_url: u(m) } : { media_type: 'STORIES', image_url: u(m) })).id;
  } else {
    const kids = [];
    for (const m of it.media) kids.push((await g('POST', `/${ig}/media`, isVideo(m) ? { media_type: 'VIDEO', video_url: u(m), is_carousel_item: 'true' } : { image_url: u(m), is_carousel_item: 'true' })).id);
    for (const k of kids) await waitReady(k);
    cid = (await g('POST', `/${ig}/media`, { media_type: 'CAROUSEL', children: kids.join(','), caption: it.caption || '' })).id;
  }
  await waitReady(cid);
  const mid = (await g('POST', `/${ig}/media_publish`, { creation_id: cid })).id;
  let permalink = null; try { permalink = (await g('GET', '/' + mid, { fields: 'permalink' })).permalink; } catch {}
  return { media_id: mid, permalink, ...(music ? { audio_id: music.audio_id, song: `${music.artist} - ${music.title}` } : {}), ...(music_error ? { music_error } : {}) };
}

const errs = validate();
if (errs.length) { console.error('Queue problems:\n- ' + errs.join('\n- ')); process.exit(1); }
if (mode === '--validate') { console.log(`queue OK (${queue.length} items)`); process.exit(0); }
if (!TOKEN) { console.error('IG_ACCESS_TOKEN is not set (GitHub > Settings > Secrets and variables > Actions).'); process.exit(mode === '--check' ? 1 : 0); }

if (mode === '--check') {
  const ig = await igUserId();
  const j = await g('GET', '/' + ig, { fields: 'username,media_count' });
  const lim = await g('GET', `/${ig}/content_publishing_limit`, { fields: 'quota_usage,config' }).catch(() => null);
  console.log(`Connected to @${j.username} (id ${ig}, ${j.media_count} posts). Publishing quota: ${JSON.stringify(lim?.data?.[0] || 'n/a')}`);
  process.exit(0);
}

if (mode === '--audio') {
  const ig = await igUserId();
  const list = await listAudio(ig, process.argv[3] || '');
  console.log(`${list.length} tracks. Trending music for this account:`);
  for (const a of list.slice(0, 15)) console.log(`- ${a.artist} - ${a.title} (${Math.round((a.raw.duration_in_ms || 0) / 1000)} s, id ${a.audio_id})`);
  process.exit(0);
}

const due = queue.filter(it => it.approved === true && !state[it.id]?.media_id && (state[it.id]?.tries || 0) < 3 && new Date(it.at) <= NOW)
  .sort((a, b) => new Date(a.at) - new Date(b.at));
if (!due.length) { console.log('Nothing due.'); process.exit(0); }

const lastFeed = Math.max(0, ...Object.values(state).filter(s => s && s.media_id && s.feed).map(s => new Date(s.published_at).getTime()));
let feedLeft = (NOW - lastFeed) / 36e5 >= FEED_GAP_H ? 1 : 0, storiesLeft = MAX_STORIES, failed = 0;
// Account-level problems (token revoked, app blocked by Meta) are recorded once in the log instead of
// failing every hourly run (which emails the owner each hour). Items stay queued until access is back.
let ig;
try { ig = await igUserId(); }
catch (e) {
  const prev = state._account_error;
  // only write when the error changes, so a long outage doesn't add a commit every hour
  if (prev?.message !== e.message) { state._account_error = { message: e.message, since: NOW.toISOString() }; saveState(); }
  console.error(`ACCOUNT ERROR (not posting, will retry next run): ${e.message}`);
  process.exit(0);
}
if (state._account_error) { delete state._account_error; saveState(); }
for (const it of due) {
  const feed = FEED.has(it.type);
  if (feed ? feedLeft <= 0 : storiesLeft <= 0) continue;
  // a story that belongs to a feed post waits until that post is out
  if (it.after && !state[it.after]?.media_id) continue;
  try {
    const r = await publish(ig, it);
    state[it.id] = { ...r, feed, published_at: NOW.toISOString() };
    console.log(`published ${it.id} ${r.permalink || r.media_id}`);
    feed ? feedLeft-- : storiesLeft--;
  } catch (e) {
    failed++; state[it.id] = { ...(state[it.id] || {}), last_error: e.message, tries: (state[it.id]?.tries || 0) + 1, failed_at: new Date().toISOString() };
    console.error(`FAILED ${it.id}: ${e.message}`);
    if (feed) feedLeft--;
  }
  saveState();
}
saveState();
process.exit(failed ? 1 : 0);
