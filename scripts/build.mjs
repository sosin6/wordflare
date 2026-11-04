// Zero-dependency static build: renders one page per language from templates + locales.
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../src/config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const LANGS = ['en', 'es', 'pt'];
const OG_LOCALE = { en: 'en_US', es: 'es_ES', pt: 'pt_BR' };
const SITE = CONFIG.SITE_URL;
const VERSION = (process.env.VERCEL_GIT_COMMIT_SHA || String(Date.now())).slice(0, 10);

const STYLES = ['pop', 'box', 'karaoke', 'clean', 'neon'];
const SWATCHES = ['#FFD43B', '#FF5C8A', '#4ADE80', '#38BDF8', '#FFFFFF'];
// Whisper language names (value) + ISO code (for display names)
const SPOKEN = [
  ['en', 'english'], ['es', 'spanish'], ['pt', 'portuguese'], ['fr', 'french'], ['de', 'german'],
  ['it', 'italian'], ['nl', 'dutch'], ['tr', 'turkish'], ['ru', 'russian'], ['pl', 'polish'],
  ['hi', 'hindi'], ['ar', 'arabic'], ['ja', 'japanese'], ['ko', 'korean'], ['zh', 'chinese'], ['id', 'indonesian'],
];
const TRANSLATE = ['en', 'es', 'pt', 'fr', 'de', 'it', 'hi', 'ar', 'ja', 'ko', 'zh'];

const RAW_KEYS = new Set(['hero.title']);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

function render(tpl, ctx) {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, key) => {
    const v = get(ctx, key);
    if (v === undefined) throw new Error(`Missing template key: ${key}`);
    if (key.startsWith('html.') || key === 'runtimeJson' || RAW_KEYS.has(key)) return String(v);
    return esc(v);
  });
}

const pagePath = (lang, page = '') => (lang === 'en' ? '/' : `/${lang}/`) + (page ? `${page}/` : '');
// pathFor: page slug (same in every language) or a function lang => path
const toPathFor = (page) => (typeof page === 'function' ? page : (l) => pagePath(l, page));
const hreflang = (page) => {
  const pf = toPathFor(page);
  return LANGS.map((l) => `<link rel="alternate" hreflang="${l}" href="${SITE}${pf(l)}">`).join('\n') +
    `\n<link rel="alternate" hreflang="x-default" href="${SITE}${pf('en')}">`;
};
const LANDINGS = JSON.parse(readFileSync(join(ROOT, 'content', 'landings.json'), 'utf8'));
const landingPath = (id) => (l) => pagePath(l, LANDINGS[id][l].slug);

function write(rel, content) {
  const file = join(DIST, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function langOptions(lang, page) {
  const pf = toPathFor(page);
  return LANGS.map((l) => {
    const name = JSON.parse(readFileSync(join(ROOT, 'locales', `${l}.json`), 'utf8')).langName;
    return `<option value="${pf(l)}"${l === lang ? ' selected' : ''}>${esc(name)}</option>`;
  }).join('');
}

function build() {
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });
  cpSync(join(ROOT, 'public'), DIST, { recursive: true });
  cpSync(join(ROOT, 'src'), join(DIST, 'assets'), { recursive: true });

  const indexTpl = readFileSync(join(ROOT, 'templates', 'index.html'), 'utf8');
  const legalTpl = readFileSync(join(ROOT, 'templates', 'legal.html'), 'utf8');
  const urls = [];

  for (const lang of LANGS) {
    const L = JSON.parse(readFileSync(join(ROOT, 'locales', `${lang}.json`), 'utf8'));
    const dn = new Intl.DisplayNames([lang], { type: 'language' });
    const cap = (s) => s.charAt(0).toLocaleUpperCase(lang) + s.slice(1);
    const runtime = {
      lang,
      home: pagePath(lang),
      t: L.app,
      styles: STYLES,
    };
    const runtimeJson = JSON.stringify(runtime).replace(/</g, '\\u003c');

    const jsonLdFor = (url, description, faqItems) => JSON.stringify([
      {
        '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'Wordflare',
        applicationCategory: 'MultimediaApplication', operatingSystem: 'Web browser',
        url, description, inLanguage: lang,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      },
      {
        '@context': 'https://schema.org', '@type': 'FAQPage',
        mainEntity: faqItems.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
      },
    ]).replace(/</g, '\\u003c');
    const usesLinks = (exceptId) => Object.keys(LANDINGS).filter((id) => id !== exceptId)
      .map((id) => `<li><a href="${landingPath(id)(lang)}">${esc(LANDINGS[id][lang].label)}</a></li>`).join('');
    const footLinks = Object.keys(LANDINGS).map((id) => `<a href="${landingPath(id)(lang)}">${esc(LANDINGS[id][lang].label)}</a>`).join('\n      ');

    const base = {
      ...L, lang, site: SITE, cfg: CONFIG, version: VERSION, runtimeJson,
      home: pagePath(lang), privacyUrl: pagePath(lang, 'privacy'), termsUrl: pagePath(lang, 'terms'),
      ogLocale: OG_LOCALE[lang],
    };

    // ---- tool pages (home + SEO landings share the same tool)
    const toolHtml = (page, faqItems, url, description, extra) => ({
      hreflang: hreflang(page),
      langOptions: langOptions(lang, page),
      jsonLd: jsonLdFor(url, description, faqItems),
      extra,
      footLinks,
      badges: L.hero.badges.map((b) => `<li>${esc(b)}</li>`).join(''),
      steps: L.how.steps.map((s, i) => `<li><span class="step-n">${i + 1}</span><h3>${esc(s.t)}</h3><p>${esc(s.d)}</p></li>`).join(''),
      proItems: L.pro.items.map((p) => `<li>${esc(p)}</li>`).join(''),
      faq: faqItems.map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join(''),
      spokenOptions: `<option value="">${esc(L.app.langAuto)}</option>` +
        SPOKEN.map(([code, name]) => [cap(dn.of(code)), name])
          .sort((a, b) => a[0].localeCompare(b[0], lang))
          .map(([label, name]) => `<option value="${name}">${esc(label)}</option>`).join(''),
      translateOptions: TRANSLATE.map((c) => `<option value="${c}">${esc(cap(dn.of(c)))}</option>`).join(''),
      styleButtons: STYLES.map((s, i) => `<button type="button" class="style-btn s-${s}${i === 0 ? ' is-on' : ''}" data-style="${s}" aria-pressed="${i === 0}"><span class="style-demo">${s === 'clean' || s === 'karaoke' ? 'Aa' : 'AA'}</span><span class="style-name">${esc(L.app.styles[s])}</span></button>`).join(''),
      swatches: SWATCHES.map((c, i) => `<button type="button" class="swatch${i === 0 ? ' is-on' : ''}" data-color="${c}" style="--c:${c}" aria-label="${c}" aria-pressed="${i === 0}"></button>`).join(''),
    });
    const homeExtra = `<section class="seo wrap"><h2>${esc(L.seo.uses)}</h2><ul class="uses">${usesLinks(null)}</ul></section>`;
    write(join(pagePath(lang).slice(1), 'index.html'), render(indexTpl, {
      ...base, canonical: SITE + pagePath(lang),
      html: toolHtml('', L.faq.items, SITE + pagePath(lang), L.meta.description, homeExtra),
    }));
    urls.push(pagePath(lang));

    for (const id of Object.keys(LANDINGS)) {
      const P = LANDINGS[id][lang];
      const path = landingPath(id)(lang);
      const faqItems = [...P.faq, ...L.faq.items.slice(0, 2)];
      const extra = `<section class="seo wrap"><div class="seo-grid">${P.sections.map((x) => `<article><h2>${esc(x.h)}</h2><p>${esc(x.p)}</p></article>`).join('')}</div>` +
        `<h2 style="margin-top:28px">${esc(L.seo.tips)}</h2><ul class="tips">${P.tips.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` +
        `<h2 style="margin-top:40px">${esc(L.seo.more)}</h2><ul class="uses">${usesLinks(id)}<li><a href="${pagePath(lang)}">Wordflare</a></li></ul></section>`;
      const ctx = {
        ...base,
        meta: { ...L.meta, title: P.title, description: P.description },
        hero: { ...L.hero, eyebrow: P.eyebrow, title: P.headline, subtitle: P.subtitle },
        canonical: SITE + path,
        html: toolHtml(landingPath(id), faqItems, SITE + path, P.description, extra),
      };
      write(join(path.slice(1), 'index.html'), render(indexTpl, ctx));
      urls.push(path);
    }

    // ---- legal pages
    for (const page of ['privacy', 'terms']) {
      const body = render(readFileSync(join(ROOT, 'content', `${page}.${lang}.html`), 'utf8'), { cfg: CONFIG });
      const pageTitle = page === 'privacy' ? L.legal.privacyTitle : L.legal.termsTitle;
      const out = render(legalTpl, {
        ...base, pageTitle, canonical: SITE + pagePath(lang, page),
        html: { hreflang: hreflang(page), body },
      });
      write(join(pagePath(lang, page).slice(1), 'index.html'), out);
      urls.push(pagePath(lang, page));
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${SITE}${u}</loc><lastmod>${today}</lastmod></url>`).join('\n')}\n</urlset>\n`);
  write('robots.txt', `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${SITE}/sitemap.xml\n`);

  // Sanity check: no unrendered placeholders anywhere in dist
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  for (const f of walk(DIST).filter((f) => f.endsWith('.html'))) {
    if (/\{\{[\w.]+\}\}/.test(readFileSync(f, 'utf8'))) throw new Error(`Unrendered placeholder in ${f}`);
  }
  console.log(`Built ${urls.length} pages → dist/ (version ${VERSION})`);
}

build();
