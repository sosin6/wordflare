/**
 * Wordflare → Google Sheet (waitlist emails + product events + stats summary).
 *
 * Update (same URL): Apps Script → paste this file → Save → Deploy → Manage deployments →
 * pencil (edit) → Version: "New version" → Deploy. The /exec URL stays the same.
 *
 * Sheets: first sheet = waitlist (date, email, feature, lang, page)
 *         "events" sheet = created automatically (date, name, data, lang, page)
 * GET ?key=STATS_KEY&days=7 returns aggregated JSON (no emails) for Claude's reports.
 */
var STATS_KEY = 'PEGAR_LA_CLAVE_ACA'; // never commit the real key: the repo is public

function doPost(e) {
  var p = (e && e.parameter) || {};
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (p.type === 'event') {
    var name = String(p.name || '').replace(/[^\w-]/g, '').slice(0, 50);
    if (!name) return ContentService.createTextOutput('invalid');
    var ev = ss.getSheetByName('events') || ss.insertSheet('events');
    if (ev.getLastRow() === 0) ev.appendRow(['date', 'name', 'data', 'lang', 'page']);
    ev.appendRow([new Date(), name, String(p.data || '').slice(0, 600), String(p.lang || '').slice(0, 5), String(p.page || '').slice(0, 80)]);
    return ContentService.createTextOutput('ok');
  }
  var email = String(p.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 200) {
    return ContentService.createTextOutput('invalid');
  }
  var sheet = ss.getSheets()[0];
  if (sheet.getLastRow() === 0) sheet.appendRow(['date', 'email', 'feature', 'lang', 'page']);
  sheet.appendRow([new Date(), email, String(p.feature || '').slice(0, 40),
    String(p.lang || '').slice(0, 5), String(p.page || '').slice(0, 60)]);
  return ContentService.createTextOutput('ok');
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.key !== STATS_KEY) return ContentService.createTextOutput('forbidden');
  var days = Math.min(90, Math.max(1, parseInt(p.days || '7', 10)));
  var since = new Date(Date.now() - days * 864e5);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var out = { days: days, generated: new Date().toISOString(), events: {}, byLang: {}, feedback: [], errors: [], waitlist: { total: 0, byFeature: {} } };

  var ev = ss.getSheetByName('events');
  if (ev && ev.getLastRow() > 1) {
    var rows = ev.getRange(2, 1, ev.getLastRow() - 1, 5).getValues();
    rows.forEach(function (r) {
      if (!(r[0] instanceof Date) || r[0] < since) return;
      var name = r[1];
      out.events[name] = (out.events[name] || 0) + 1;
      if (name === 'tool_used') out.byLang[r[3]] = (out.byLang[r[3]] || 0) + 1;
      if (name === 'feedback' && out.feedback.length < 50) out.feedback.push({ date: r[0], text: r[2], lang: r[3] });
      if (/error|empty|failed/.test(name) && out.errors.length < 50) out.errors.push({ date: r[0], name: name, data: r[2], page: r[4] });
    });
  }
  var wl = ss.getSheets()[0];
  if (wl.getLastRow() > 1) {
    wl.getRange(2, 1, wl.getLastRow() - 1, 3).getValues().forEach(function (r) {
      if (!(r[0] instanceof Date) || r[0] < since) return;
      out.waitlist.total++;
      out.waitlist.byFeature[r[2]] = (out.waitlist.byFeature[r[2]] || 0) + 1;
    });
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
