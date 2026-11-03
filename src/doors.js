// Fake doors: "coming soon" Pro features that measure demand and collect waitlist emails.
import { CONFIG } from './config.js';
import { track } from './analytics.js';

const $ = (id) => document.getElementById(id);
let current = null;
const joined = new Set(JSON.parse(safeGet('wf_waitlist') || '[]'));

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

export function initDoors(t) {
  const dlg = $('doorDialog');
  const form = $('doorForm');

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-door]');
    if (btn) { e.preventDefault(); openDoor(btn.dataset.door, t); }
  });
  document.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-door-select]');
    if (sel && sel.value) { openDoor(sel.dataset.doorSelect, t, { target: sel.value }); sel.value = ''; }
  });

  form.addEventListener('submit', async (e) => {
    const submitter = e.submitter;
    if (!submitter || submitter.value !== 'submit') return; // close button
    e.preventDefault();
    const email = $('doorEmail').value.trim();
    const consent = $('doorConsent').checked;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || !consent) { $('doorErr').hidden = false; return; }
    $('doorErr').hidden = true;
    $('doorSubmit').disabled = true;
    // Google Apps Script answers slowly: send in the background (keepalive survives closing the tab).
    const body = new URLSearchParams({ email, feature: current?.feature || '', lang: window.WF.lang, ts: new Date().toISOString(), page: location.pathname });
    fetch(CONFIG.LEADS_ENDPOINT, { method: 'POST', mode: 'no-cors', body, keepalive: true }).catch(() => track('lead_send_error'));
    track(`fake_door_email_${current?.feature || 'unknown'}`, { lang: window.WF.lang });
    joined.add(current?.feature || 'any');
    safeSet('wf_waitlist', JSON.stringify([...joined]));
    $('doorEmailBox').hidden = true;
    $('doorThanks').hidden = false;
    $('doorSubmit').disabled = false;
  });

  dlg.addEventListener('close', () => { current = null; });
}

export function openDoor(feature, t, extra = {}) {
  current = { feature, ...extra };
  track(`fake_door_${feature}`, { lang: window.WF.lang, ...(extra.target ? { target: extra.target } : {}) });
  const d = t.door;
  const isLong = feature === 'longvideo';
  $('doorTitle').textContent = isLong ? d.longvideo : (featureLabel(feature, t) || d.title);
  const hasEndpoint = !!CONFIG.LEADS_ENDPOINT;
  const already = joined.size > 0;
  $('doorBody').textContent = isLong ? d.longvideoBody : (hasEndpoint ? d.body : d.bodyNoEmail);
  $('doorEmailBox').hidden = !hasEndpoint || already;
  $('doorFollow').hidden = hasEndpoint && !already;
  $('doorThanks').hidden = !(hasEndpoint && already);
  $('doorErr').hidden = true;
  const dlg = $('doorDialog');
  if (!dlg.open) dlg.showModal();
  if (hasEndpoint && !already) setTimeout(() => $('doorEmail').focus(), 50);
}

function featureLabel(feature, t) {
  const map = { translate: t.pro.translate, autoplace: t.pro.autoplace, export4k: t.pro.export4k, batch: t.pro.batch, brandkit: t.pro.brandkit, emojis: t.pro.emojis };
  return map[feature] || t.door.title;
}
