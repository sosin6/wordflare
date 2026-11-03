/**
 * Wordflare waitlist → Google Sheet.
 * Setup (5 min, with the Wordflare Gmail):
 * 1. Create a Google Sheet named "Wordflare waitlist".
 * 2. Extensions → Apps Script. Replace everything with this file. Save.
 * 3. Deploy → New deployment → type "Web app".
 *    Execute as: Me · Who has access: Anyone. Deploy and authorize.
 * 4. Copy the Web app URL into LEADS_ENDPOINT in src/config.js.
 */
function doPost(e) {
  var p = (e && e.parameter) || {};
  var email = String(p.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 200) {
    return ContentService.createTextOutput('invalid');
  }
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  if (sheet.getLastRow() === 0) sheet.appendRow(['date', 'email', 'feature', 'lang', 'page']);
  sheet.appendRow([
    new Date(),
    email,
    String(p.feature || '').slice(0, 40),
    String(p.lang || '').slice(0, 5),
    String(p.page || '').slice(0, 60),
  ]);
  return ContentService.createTextOutput('ok');
}
