// Private stats proxy for Claude's scheduled reports.
// Google Apps Script answers through a cross-host redirect that some fetchers can't follow,
// so this function follows it server-side. Key and sheet URL live only in Vercel env vars.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  const key = String(req.query.key || '');
  if (!process.env.STATS_KEY || !process.env.STATS_URL || key !== process.env.STATS_KEY) {
    return res.status(403).send('forbidden');
  }
  const days = Math.min(90, Math.max(1, parseInt(req.query.days || '7', 10) || 7));
  try {
    const r = await fetch(`${process.env.STATS_URL}?key=${encodeURIComponent(process.env.STATS_KEY)}&days=${days}`, { redirect: 'follow' });
    const text = await r.text();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(r.ok ? 200 : 502).send(text);
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 200) });
  }
}
