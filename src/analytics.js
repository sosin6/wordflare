// Privacy-friendly analytics (Umami, cookieless) + error reporting.
import { CONFIG } from './config.js';

const queue = [];
let ready = false;

export function track(name, data) {
  const payload = data ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v).slice(0, 400)])) : undefined;
  if (ready && window.umami) { try { window.umami.track(name.slice(0, 50), payload); } catch {} }
  else queue.push([name, payload]);
  if (window.WF?.debug) console.debug('[track]', name, payload || '');
}

export function initAnalytics() {
  installErrorReporting();
  if (!CONFIG.UMAMI_WEBSITE_ID || /localhost|127\.0\.0\.1/.test(location.hostname) || new URLSearchParams(location.search).has('e2e')) return;
  const s = document.createElement('script');
  s.defer = true;
  s.src = 'https://cloud.umami.is/script.js';
  s.dataset.websiteId = CONFIG.UMAMI_WEBSITE_ID;
  s.onload = () => {
    ready = true;
    while (queue.length) { const [n, p] = queue.shift(); try { window.umami.track(n.slice(0, 50), p); } catch {} }
  };
  document.head.appendChild(s);
}

let errorCount = 0;
function installErrorReporting() {
  const report = (message, source, line) => {
    if (errorCount++ > 10) return;
    track('js_error', {
      message: String(message || 'unknown').slice(0, 200),
      source: String(source || '').replace(location.origin, '').slice(0, 120),
      line: line || 0,
      lang: window.WF?.lang || '',
    });
  };
  window.addEventListener('error', (e) => report(e.message, e.filename, e.lineno));
  window.addEventListener('unhandledrejection', (e) => report(e.reason?.message || e.reason, 'promise', 0));
}

export function reportError(where, err) {
  track('js_error', { message: `${where}: ${String(err?.message || err).slice(0, 180)}`, source: 'app', line: 0, lang: window.WF?.lang || '' });
}
