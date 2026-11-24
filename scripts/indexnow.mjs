// Tells IndexNow (Bing, Yandex, Seznam, Naver) which pages changed in this upload, so they
// re-crawl them within minutes instead of waiting for the sitemap.
// Usage: node scripts/indexnow.mjs <changed-list> <removed-list>
// Each list holds one dist-relative file per line (./signing/x/index.html), as the publish
// workflow writes them. Only URLs in dist/sitemap.xml are sent (no noindex pages), plus
// pages that were deleted (so they drop out sooner). Never fails the publish.
import { readFile } from 'node:fs/promises';

const ORIGIN = (process.env.SITE_ORIGIN || 'https://autographhero.com').replace(/\/$/, '');
const KEY = (process.env.INDEXNOW_KEY || '50ef44119e63bde18290c2a7944e0969').trim();
const read = async (f) => (f ? (await readFile(f, 'utf8').catch(() => '')) : '').split('\n').map((l) => l.trim()).filter(Boolean);
const toUrl = (f) => {
  const p = f.replace(/^\.\//, '/');
  if (p.endsWith('/index.html')) return ORIGIN + p.slice(0, -'index.html'.length);
  return null; // assets, feeds, etc.
};

try {
  const [changed, removed, sitemap] = await Promise.all([read(process.argv[2]), read(process.argv[3]), readFile('dist/sitemap.xml', 'utf8').catch(() => '')]);
  const inSitemap = new Set([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&')));
  const urls = [...new Set([
    ...changed.map(toUrl).filter((u) => u && inSitemap.has(u)),
    ...removed.map(toUrl).filter(Boolean),
  ])];
  if (!urls.length) { console.log('IndexNow: nothing to send'); process.exit(0); }
  for (let i = 0; i < urls.length; i += 10000) {
    const res = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host: new URL(ORIGIN).host, key: KEY, keyLocation: `${ORIGIN}/${KEY}.txt`, urlList: urls.slice(i, i + 10000) }),
    });
    console.log(`IndexNow: sent ${Math.min(10000, urls.length - i)} URLs, HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
} catch (e) {
  console.log(`::warning::IndexNow submit failed: ${e.message}`);
}
