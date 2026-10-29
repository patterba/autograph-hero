// Autograph Hero site generator.
// Reads published signings from Supabase and writes a static site to ./dist.
// No dependencies: run with `node build.mjs` (Node 20+).

import { mkdir, writeFile, rm, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, 'dist');

// The publishable key is safe to ship: the database only lets it read rows
// whose status is 'published'.
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://ravavlocylqvkmthevtv.supabase.co').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_a6auUU4qDwaY0vcOpHG9YA_yTMtet1O';
const BASE = (process.env.BASE_PATH || '').replace(/\/$/, '');
const NOINDEX = process.env.SITE_NOINDEX === '1';
const SITE_NAME = 'Autograph Hero';
// Public endpoint for the "Submit a signing" and sign-up forms (Supabase function site-forms).
const FORMS_URL = process.env.FORMS_URL || `${SUPABASE_URL}/functions/v1/site-forms`;
// "Email me a reminder" on signing pages and its cancel link (supabase/functions/signing-reminders).
const REMIND_URL = process.env.REMIND_URL || `${SUPABASE_URL}/functions/v1/signing-reminders`;
// Cloudflare Turnstile site key (public) for the check on "Submit a signing".
// Set as the GitHub repository variable TURNSTILE_SITE_KEY; empty = no check shown.
const TURNSTILE_SITE_KEY = (process.env.TURNSTILE_SITE_KEY || '').trim();
// Cloudflare Web Analytics token for autographhero.com. It is public (it sits in every page).
// The GitHub variable CF_ANALYTICS_TOKEN overrides it; set ANALYTICS=off to build without it.
const CF_ANALYTICS_TOKEN = process.env.ANALYTICS === 'off' ? '' : (process.env.CF_ANALYTICS_TOKEN || '35d2f0b32d714998a1157305df2b7064').trim();
// Contact address shown on the Terms and Privacy pages (GitHub variable CONTACT_EMAIL).
const CONTACT_EMAIL = (process.env.CONTACT_EMAIL || '').trim();
// Date the Terms and Privacy pages were last changed. Update it when you edit them.
const POLICY_DATE = '2026-10-28';
// Our own cookie-free unique visitor count (supabase/functions/site-visit). VISIT_COUNT=off turns it off.
const COUNT_VISITS = process.env.VISIT_COUNT !== 'off';
// The live address, for canonical links, the sitemap and share previews.
const ORIGIN = (process.env.SITE_ORIGIN || 'https://autographhero.com').replace(/\/$/, '');
// Search engine ownership checks (Google Search Console / Bing Webmaster Tools, "HTML tag" method).
// These codes are public: they only prove who owns the site. GitHub variables can override them.
const GOOGLE_VERIFY = (process.env.GOOGLE_SITE_VERIFICATION || '').trim();
const BING_VERIFY = (process.env.BING_SITE_VERIFICATION || '').trim();
const US_STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
const SPORT_CHOICES = ['Football', 'Baseball', 'Basketball', 'Hockey', 'Soccer', 'Wrestling', 'MMA', 'Golf', 'Racing', 'Entertainment', 'Other'];

const COLUMNS = [
  'id', 'title', 'athlete_names', 'signing_type', 'event_date', 'event_date_text',
  'event_time_text', 'order_deadline', 'venue', 'city', 'state', 'price_min', 'price_max',
  'prices', 'sport', 'team_city', 'listing_url', 'image_url', 'image_source',
  'image_credit', 'image_license', 'image_page_url', 'status',
];

const TYPE_LABEL = { public: 'In person', private: 'Private signing', 'mail-in': 'Mail-in', unknown: 'Signing' };
const TYPE_BLURB = {
  public: 'Meet the signer in person at the venue.',
  private: 'Not open to the public. Send in or drop off your item and the promoter gets it signed.',
  'mail-in': 'Order online, mail in your item (or buy one from the promoter) and it is shipped back signed.',
  unknown: 'Check the organizer page for how this signing works.',
};

// ---------- helpers ----------

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function safeUrl(u) {
  try {
    const url = new URL(String(u));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const toUTC = (s) => new Date(`${s}T00:00:00Z`);
const fmt = (s, opts) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }).format(toUTC(s));
const longDate = (s) => fmt(s, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const shortDate = (s) => fmt(s, { weekday: 'short', month: 'short', day: 'numeric' });
const compact = (s) => s.replaceAll('-', '');
const nextDay = (s) => new Date(toUTC(s).getTime() + 86400000).toISOString().slice(0, 10);

// "Today" on the US west coast, so a listing stays up through its whole day nationwide.
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());

function money(n) {
  if (n === null || n === undefined || n === '') return null;
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 });
}

function joinNames(names) {
  if (names.length <= 1) return names[0] || '';
  if (names.length === 2) return names.join(' & ');
  return `${names.slice(0, -1).join(', ')} & ${names.at(-1)}`;
}

const link = (p) => `${BASE}${p}`;
const abs = (p) => ORIGIN + link(p);
// Structured data for search engines. "<" is escaped so scraped text can't close the script tag.
const jsonLd = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`;
const mdy = (s) => fmt(s, { month: 'short', day: 'numeric', year: 'numeric' });
// Asset links carry a short hash of the file, so browsers and the host's cache
// fetch the new CSS/JS as soon as it changes instead of keeping an old copy.
const asset = (p) => {
  const v = createHash('sha1').update(readFileSync(path.join(ROOT, p))).digest('hex').slice(0, 8);
  return `${link(p)}?v=${v}`;
};

// ---------- data ----------

async function loadSignings() {
  const qs = new URLSearchParams({
    select: COLUMNS.join(','),
    // 'past' rows are signings that were on the site and have happened (Signing Archives).
    status: 'in.(published,past)',
    order: 'event_date.asc.nullslast,id.asc',
    limit: '5000',
  });
  const res = await fetch(`${SUPABASE_URL}/rest/v1/signings?${qs}`, { headers: { apikey: SUPABASE_KEY } });
  if (!res.ok) throw new Error(`Supabase returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('Supabase did not return a list of signings');
  return rows;
}

// Teams come from public.athletes, which the weekly crawl fills from Wikipedia.
// The public key only sees rows marked 'confirmed'. If this fails, the site
// still builds, just without team names.
async function loadAthletes() {
  const byName = new Map();
  try {
    const qs = new URLSearchParams({ select: 'name,sport,teams,image_url,image_credit,image_license,image_page_url', limit: '5000' });
    const res = await fetch(`${SUPABASE_URL}/rest/v1/athletes?${qs}`, { headers: { apikey: SUPABASE_KEY } });
    if (!res.ok) throw new Error(`Supabase returned ${res.status}`);
    const rows = await res.json();
    for (const a of Array.isArray(rows) ? rows : []) {
      if (typeof a?.name !== 'string' || !Array.isArray(a.teams)) continue;
      const key = a.name.trim().toLowerCase();
      byName.set(key, [...(byName.get(key) || []), a]);
    }
  } catch (err) {
    console.warn(`Could not load athlete teams (${err.message}); building without them.`);
  }
  return byName;
}

const THIS_YEAR = Number(TODAY.slice(0, 4));

// All teams for the signers, in career order, plus the one they are best known for
// (the most years across all stints).
function teamsFor(names, sport, athletes) {
  const years = new Map();
  let anyYears = false;
  let current = null;
  for (const n of names) {
    const rows = athletes.get(n.trim().toLowerCase()) || [];
    const row = rows.find((a) => a.sport === sport) || rows[0];
    const stints = (row?.teams || []).filter((t) => t && typeof t.team === 'string' && t.team.trim());
    stints.forEach((t, i) => {
      const from = Number.isInteger(t.from_year) ? t.from_year : null;
      // A missing end year means "current" only on the last stint; otherwise count one season.
      const to = Number.isInteger(t.to_year) ? t.to_year : i === stints.length - 1 ? THIS_YEAR : from;
      const span = from && to ? Math.max(1, to - from + 1) : 0;
      if (span) anyYears = true;
      years.set(t.team, (years.get(t.team) || 0) + span);
      // An active player (last stint has a start year and no end year) is shown with today's team.
      if (i === stints.length - 1 && from && !Number.isInteger(t.to_year) && names.length === 1) current = t.team;
    });
  }
  const teams = [...years.keys()];
  // Without any years we can't tell which team they're known for, so don't pick one.
  const primary = current || anyYears && teams.reduce((best, t) => (best === null || years.get(t) > years.get(best) ? t : best), null) || null;
  return { teams, primary };
}

// A freely licensed Wikimedia Commons photo of the first signer that has one.
function freePhotoFor(names, sport, athletes) {
  for (const n of names) {
    const rows = athletes.get(n.trim().toLowerCase()) || [];
    const a = rows.find((r) => r.sport === sport && r.image_url) || rows.find((r) => r.image_url);
    const url = a && safeUrl(a.image_url);
    if (url) {
      return { url, credit: a.image_credit || 'Wikimedia Commons', license: a.image_license || null, page: safeUrl(a.image_page_url), wikimedia: true, of: n };
    }
  }
  return null;
}

function shape(row, athletes) {
  const names = Array.isArray(row.athlete_names) ? row.athlete_names.filter((n) => typeof n === 'string' && n.trim()) : [];
  const name = joinNames(names) || row.title || 'Autograph signing';
  const eventDate = isDate(row.event_date) ? row.event_date : null;
  const deadline = isDate(row.order_deadline) ? row.order_deadline : null;
  const sortDate = eventDate || deadline;
  const type = TYPE_LABEL[row.signing_type] ? row.signing_type : 'unknown';
  const listingUrl = safeUrl(row.listing_url);
  const host = listingUrl ? new URL(listingUrl).hostname.replace(/^www\./, '') : null;
  const source = row.image_source === 'promoter' && row.image_credit ? row.image_credit : host;
  const place = [row.city, row.state].filter(Boolean).join(', ');
  const priceMin = money(row.price_min);
  const priceMax = money(row.price_max);
  const { teams, primary } = teamsFor(names, row.sport, athletes);
  // Promoter photo first; a free Commons photo of the player is the backup, used when
  // there is no promoter photo or it fails to load in the browser.
  const ownUrl = safeUrl(row.image_url);
  const own = ownUrl
    ? { url: ownUrl, credit: row.image_credit || null, license: row.image_license || null, page: safeUrl(row.image_page_url), wikimedia: row.image_source === 'wikimedia' }
    : null;
  const free = freePhotoFor(names, row.sport, athletes);
  const mainPhoto = own || free;
  const fallbackPhoto = own && free && free.url !== own.url ? free : null;
  const prices = Array.isArray(row.prices)
    ? row.prices.filter((p) => p && typeof p.item === 'string' && money(p.price)).map((p) => ({ item: p.item, price: money(p.price) }))
    : [];
  return {
    id: row.id,
    slug: `${row.id}-${slugify(name) || 'signing'}`,
    name,
    names,
    title: row.title || name,
    type,
    eventDate,
    eventDateText: row.event_date_text || null,
    timeText: row.event_time_text || null,
    deadline,
    deadlinePassed: Boolean(deadline && deadline < TODAY),
    sortDate,
    // Over: the date has gone by, or the weekly crawl has marked it past.
    past: row.status === 'past' || !(sortDate && sortDate >= TODAY),
    venue: row.venue || null,
    city: row.city || null,
    state: row.state || null,
    place,
    location: [row.venue, row.city, row.state].filter(Boolean).join(', '),
    priceMin,
    priceMax,
    priceLow: Number.isFinite(Number(row.price_min)) && row.price_min !== null ? Number(row.price_min) : null,
    priceHigh: Number.isFinite(Number(row.price_max)) && row.price_max !== null ? Number(row.price_max) : null,
    prices,
    sport: row.sport || null,
    teamCity: row.team_city || null,
    teams,
    primaryTeam: primary,
    listingUrl,
    host,
    source,
    photo: mainPhoto,
    photoFallback: fallbackPhoto,
  };
}

// ---------- components ----------

const X_URL = 'https://x.com/autographheroX';

const ICON = {
  x: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',
  search: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
  arrow: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  out: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"/></svg>',
  cal: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4M12 13v5M9.5 15.5h5"/></svg>',
  pin: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
  plus: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  user: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg>',
  bell: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>',
  // Full logo: "Autograph" in brush script over block-letter HERO, with a cape on the H. The script is live text in
  // Yellowtail (loaded with the other fonts); its outline color comes from site.css. The favicon (assets/logo.svg) is the caped H alone.
  logo: '<svg class="logo-lockup" viewBox="-170 -128 566 334" role="img" aria-label="Autograph Hero"><path d="M34 0 H8 C-50 -4 -110 24 -164 76 Q-138 84 -146 112 Q-118 114 -124 146 Q-96 142 -98 184 C-84 130 -44 70 0 44 H34 Z" fill="#FF6A00"/><path d="M0 0 H34 V83 H58 V0 H92 V200 H58 V117 H34 V200 H0 Z" fill="#0A0A0A"/><path d="M102 0 H180 V32 H136 V84 H172 V116 H136 V168 H180 V200 H102 Z" fill="#0A0A0A"/><path fill-rule="evenodd" d="M190 0 H250 A34 34 0 0 1 284 34 V82 A34 34 0 0 1 250 116 H190 Z M224 30 H244 A8 8 0 0 1 252 38 V78 A8 8 0 0 1 244 86 H224 Z" fill="#0A0A0A"/><path d="M190 0 H224 V200 H190 Z M230 110 H262 L286 200 H252 Z" fill="#0A0A0A"/><path fill-rule="evenodd" d="M330 0 H354 A34 34 0 0 1 388 34 V166 A34 34 0 0 1 354 200 H330 A34 34 0 0 1 296 166 V34 A34 34 0 0 1 330 0 Z M338 32 H346 A8 8 0 0 1 354 40 V160 A8 8 0 0 1 346 168 H338 A8 8 0 0 1 330 160 V40 A8 8 0 0 1 338 32 Z" fill="#0A0A0A"/><text x="-7" y="0" transform="rotate(-6 -7 21)">Autograph</text></svg>',
};

const badge = (s) => `<span class="badge badge-${esc(s.type)}">${esc(TYPE_LABEL[s.type])}</span>`;

function photo(s, cls = '', id = '') {
  // The whole photo is shown (nothing cropped off), over a blurred copy of itself that fills the box.
  const img = s.photo
    ? `<img class="photo-bg" src="${esc(s.photo.url)}" alt="" aria-hidden="true" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()"><img${id ? ` id="${id}"` : ''} src="${esc(s.photo.url)}"${s.photoFallback ? ` data-fallback="${esc(s.photoFallback.url)}"` : ''} alt="${esc(s.name)}" loading="lazy" referrerpolicy="no-referrer" onerror="ahPhoto(this)">`
    : '';
  return `<div class="photo ${cls}">${img}</div>`;
}

function creditLine(p, id, hidden = false) {
  if (!p) return '';
  const who = p.wikimedia && p.page ? `<a href="${esc(p.page)}" rel="noopener">${esc(p.credit)}</a>` : esc(p.credit || 'the organizer');
  return `<p class="credit" id="${id}"${hidden ? ' hidden' : ''}>Photo: ${who}${p.license ? `, ${esc(p.license)}` : ''}${p.wikimedia ? ', via Wikimedia Commons' : ''}</p>`;
}

// Runs when a photo fails to load: switch to the backup photo (and its credit), or hide it.
const PHOTO_SCRIPT = `<script>function ahPhoto(i){var f=i.getAttribute('data-fallback'),m=i.id==='main-photo',a=document.getElementById('credit-main'),b=document.getElementById('credit-fb'),g=i.parentNode&&i.parentNode.querySelector('.photo-bg');i.removeAttribute('data-fallback');if(f){i.onerror=function(){i.remove();if(g)g.remove();if(m&&b)b.hidden=true};i.src=f;if(g){g.onerror=function(){g.remove()};g.src=f}if(m){if(a)a.hidden=true;if(b)b.hidden=false}}else{i.remove();if(g)g.remove();if(m&&a)a.hidden=true}}</script>`;

function whereLine(s) {
  if (s.type === 'mail-in') return `Mail-in${s.source ? ` · ${s.source}` : ''}`;
  if (s.venue && s.place) return `${s.venue.split(',')[0]}, ${s.place}`;
  return s.venue || s.place || (s.source ? `Via ${s.source}` : 'Location on organizer page');
}

function whenLine(s) {
  if (s.past) return s.eventDate ? mdy(s.eventDate) : s.deadline ? `Ended ${mdy(s.deadline)}` : 'Past signing';
  if (s.eventDate) return shortDate(s.eventDate);
  if (s.deadline) return `Order by ${fmt(s.deadline, { month: 'short', day: 'numeric' })}`;
  return s.eventDateText || 'Date to be announced';
}

function priceLine(s) {
  if (!s.priceMin) return '';
  return s.priceMax && s.priceMax !== s.priceMin ? `From ${s.priceMin}` : s.priceMin;
}

function card(s) {
  const q = [s.name, s.title, s.venue, s.city, s.state, s.sport, s.teamCity, ...s.teams, s.source].filter(Boolean).join(' ').toLowerCase();
  return `<a class="card" href="${esc(link(`/signing/${s.slug}/`))}" data-q="${esc(q)}" data-sport="${esc(s.sport || '')}" data-type="${esc(s.type)}" data-state="${esc(s.state || '')}">
  <div class="card-photo">${photo(s)}${badge(s)}</div>
  <div class="card-body">
    <div class="eyebrow">${esc([s.sport, s.primaryTeam].filter(Boolean).join(' · ') || 'Autographs')}</div>
    <h3>${esc(s.name)}</h3>
    <p class="where">${ICON.pin}<span>${esc(whereLine(s))}</span></p>
  </div>
  <div class="card-foot">
    <span class="mono">${esc(whenLine(s))}</span>
    <span class="price">${esc(priceLine(s))}</span>
  </div>
</a>`;
}

// A card-sized prompt that sits among the signings and asks fans to add one.
function submitPrompt() {
  return `<a class="promo" href="${esc(link('/add/'))}">
  <span class="eyebrow">Built by fans</span>
  <span class="promo-title">Know a signing we're missing?</span>
  <span class="promo-text">Send it in. We check every one and add it to the calendar.</span>
  <span class="btn btn-ink btn-sm">${ICON.plus}Submit A Signing</span>
</a>`;
}

// The last card in a feed: a link to every signing, sized like the others so rows end full.
function moreCard(total, remaining, sport = null) {
  const href = sport ? `/events/?sport=${encodeURIComponent(sport)}` : '/events/';
  const line = sport ? `All upcoming ${sport.toLowerCase()} signings` : remaining > 0 ? `${remaining} more coming up` : `${total} upcoming in all`;
  return `<a class="card card-more" href="${esc(link(href))}">
  <span class="eyebrow">${esc(line)}</span>
  <span class="card-more-title">See more signings</span>
  <span class="card-more-arrow">${ICON.arrow}</span>
</a>`;
}

// ---------- installable app (PWA) ----------
// Home-screen icon, launch screens and offline copies. Icons and launch screens in assets/app/ are
// rendered from the caped-H mark in assets/logo.svg; re-render them if the logo changes.

const APP_COLOR = '#F6F1E7'; // --paper: status bar and launch background
// iOS launch screens, portrait: [file, CSS width, CSS height, pixel ratio].
const SPLASH = [
  [440, 956, 3], [420, 912, 3], [402, 874, 3], [430, 932, 3], [393, 852, 3], [428, 926, 3], [390, 844, 3],
  [414, 896, 3], [375, 812, 3], [414, 896, 2], [375, 667, 2], [1024, 1366, 2], [834, 1194, 2], [820, 1180, 2], [768, 1024, 2],
].map(([w, h, r]) => ({ file: `/assets/app/splash/splash-${w * r}x${h * r}.png`, media: `(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${r}) and (orientation: portrait)` }));

function appHead() {
  return [
    `<meta name="theme-color" content="${APP_COLOR}">`,
    `<link rel="manifest" href="${esc(link('/manifest.webmanifest'))}">`,
    `<link rel="apple-touch-icon" href="${esc(asset('/assets/app/apple-touch-icon.png'))}">`,
    '<meta name="mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    `<meta name="apple-mobile-web-app-title" content="${SITE_NAME}">`,
    '<meta name="apple-mobile-web-app-status-bar-style" content="default">',
    ...SPLASH.map((s) => `<link rel="apple-touch-startup-image" media="${s.media}" href="${esc(link(s.file))}">`),
  ].join('\n');
}

function manifest() {
  const icon = (file, size, purpose) => ({ src: link(`/assets/app/${file}`), sizes: `${size}x${size}`, type: 'image/png', purpose });
  return JSON.stringify({
    id: link('/'),
    name: SITE_NAME,
    short_name: SITE_NAME,
    description: 'Autograph signings, meet & greets and mail-ins in one place. Never miss a signing.',
    start_url: link('/?source=app'),
    scope: link('/'),
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'portrait',
    background_color: APP_COLOR,
    theme_color: APP_COLOR,
    lang: 'en-US',
    categories: ['entertainment', 'sports', 'lifestyle'],
    icons: [icon('icon-192.png', 192, 'any'), icon('icon-512.png', 512, 'any'), icon('maskable-192.png', 192, 'maskable'), icon('maskable-512.png', 512, 'maskable')],
    shortcuts: [
      { name: 'All Signings', url: link('/events/?source=app'), icons: [icon('icon-192.png', 192, 'any')] },
      { name: 'In Person', url: link('/events/?type=public&source=app'), icons: [icon('icon-192.png', 192, 'any')] },
      { name: 'Mail-In', url: link('/events/?type=mail-in&source=app'), icons: [icon('icon-192.png', 192, 'any')] },
      { name: 'Submit A Signing', url: link('/add/?source=app'), icons: [icon('icon-192.png', 192, 'any')] },
    ],
  }, null, 2);
}

// The offline worker. Pages: network first (always fresh online), with the last copy of every page
// you opened kept for when there's no signal; anything else falls back to /offline/. Site assets are
// versioned (?v=), so they're served from the cache. Promoter photos and Supabase calls go straight to
// the network. Rebuilt every publish with the current asset versions, so browsers pick up changes.
function serviceWorker() {
  const precache = [link('/offline/'), asset('/assets/site.css'), asset('/assets/app.js'), asset('/assets/logo.svg'), link('/assets/app/icon-192.png'), link('/assets/app/badge-96.png')];
  return `// Autograph Hero offline worker (generated by build.mjs; edit serviceWorker() there).
const VERSION = 'ah-v1';
const STATIC = VERSION + '-static', PAGES = VERSION + '-pages', FONTS = VERSION + '-fonts';
const BASE = ${JSON.stringify(BASE)};
const OFFLINE = ${JSON.stringify(link('/offline/'))};
const PRECACHE = ${JSON.stringify(precache)};
const NEVER = [BASE + '/admin/'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(STATIC).then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (!k.startsWith(VERSION + '-')) await caches.delete(k);
    await trim(STATIC, 60);
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
    await self.clients.claim();
  })());
});

async function trim(name, max) {
  const c = await caches.open(name);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}

const isPrivate = (u) => NEVER.some((p) => u.pathname.startsWith(p));

async function page(e, u) {
  try {
    const res = (await e.preloadResponse) || (await fetch(e.request));
    if (res.ok && res.type === 'basic' && !isPrivate(u)) {
      const copy = res.clone();
      e.waitUntil(caches.open(PAGES).then((c) => c.put(u.pathname + u.search, copy)).then(() => trim(PAGES, 80)));
    }
    return res;
  } catch (err) {
    if (!isPrivate(u)) {
      const c = await caches.open(PAGES);
      // Same page, any query (the home-screen icon opens "/?source=app").
      const hit = (await c.match(u.pathname + u.search)) || (await c.match(u.pathname, { ignoreSearch: true }));
      if (hit) return hit;
    }
    return (await caches.match(OFFLINE)) || Response.error();
  }
}

async function cacheFirst(req, name) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') (await caches.open(name)).put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin === self.location.origin) {
    if (req.mode === 'navigate') return e.respondWith(page(e, u));
    if (u.pathname.startsWith(BASE + '/assets/')) return e.respondWith(cacheFirst(req, STATIC));
    return;
  }
  // Google Fonts, so pages keep their look offline.
  if (u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com') {
    e.respondWith(cacheFirst(req, FONTS).catch(() => Response.error()));
  }
});

// Alerts pushed to the installed app: { title, body, url }.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Autograph Hero', {
    body: d.body || 'A new signing was just added.',
    icon: BASE + '/assets/app/icon-192.png',
    badge: BASE + '/assets/app/badge-96.png',
    tag: d.tag,
    data: { url: d.url || BASE + '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || BASE + '/', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) if (w.url === target) return w.focus();
    if (wins[0] && 'navigate' in wins[0]) { await wins[0].navigate(target); return wins[0].focus(); }
    return self.clients.openWindow(target);
  })());
});
`;
}

// noindex: true keeps a page out of search results; 'follow' does the same but lets search engines follow its links.
// image: an absolute photo URL for share previews (defaults to assets/social.png). ld: structured data objects.
function page({ title, description, pathname, body, script = false, forms = false, captcha = false, account = false, admin = false, remind = false, noindex = false, image = null, imageAlt = null, ld = [], ogType = 'website' }) {
  const full = title ? `${title} | ${SITE_NAME}` : `${SITE_NAME}: Autograph Signings, Meet & Greets and Mail-Ins`;
  const hidden = NOINDEX || admin || noindex;
  const robots = NOINDEX || admin ? 'noindex, nofollow' : noindex === 'follow' ? 'noindex, follow' : noindex ? 'noindex, nofollow' : 'index, follow, max-image-preview:large';
  const canonical = pathname.endsWith('/') ? abs(pathname) : null;
  const shareImage = image || abs('/assets/social.png');
  return `<!doctype html>
<html lang="en" data-base="${esc(BASE)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(full)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="${robots}">
${canonical && !hidden ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
${GOOGLE_VERIFY && pathname === '/' ? `<meta name="google-site-verification" content="${esc(GOOGLE_VERIFY)}">` : ''}
${BING_VERIFY && pathname === '/' ? `<meta name="msvalidate.01" content="${esc(BING_VERIFY)}">` : ''}
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:title" content="${esc(title || full)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="${esc(ogType)}">
${canonical ? `<meta property="og:url" content="${esc(canonical)}">` : ''}
<meta property="og:image" content="${esc(shareImage)}">
${image ? '' : '<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">'}
<meta property="og:image:alt" content="${esc(imageAlt || `${SITE_NAME}: never miss a signing`)}">
<meta name="twitter:card" content="${image ? 'summary' : 'summary_large_image'}">
${hidden ? '' : ld.filter(Boolean).map(jsonLd).join('\n')}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anton&family=Yellowtail&family=IBM+Plex+Mono:wght@500;600&family=Instrument+Sans:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="${esc(asset('/assets/site.css'))}">
<link rel="icon" type="image/svg+xml" href="${esc(asset('/assets/logo.svg'))}">
${admin ? '' : appHead()}
${PHOTO_SCRIPT}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <a class="brand" href="${esc(link('/'))}">${ICON.logo}</a>
  <nav aria-label="Main">
    <a href="${esc(link('/events/'))}"${pathname === '/events/' ? ' aria-current="page"' : ''}>All Signings</a>
    <a href="${esc(link('/events/?type=public'))}">In Person</a>
    <a href="${esc(link('/events/?type=mail-in'))}">Mail-In</a>
    <a class="nav-login" href="${esc(link('/account/'))}"${pathname === '/account/' ? ' aria-current="page"' : ''}>${ICON.user}Log In</a>
  </nav>
  <div class="header-actions">
    <a class="btn btn-accent btn-sm btn-pop" href="${esc(link('/add/'))}"${pathname === '/add/' ? ' aria-current="page"' : ''}>${ICON.plus}Submit A Signing</a>
    <a class="btn btn-ink btn-sm btn-stack" href="${esc(link('/signup/'))}"${pathname === '/signup/' ? ' aria-current="page"' : ''}><span class="btn-main">Sign Up</span><span class="btn-sub">Never Miss A Signing</span></a>
  </div>
</header>
<main id="main">
${body}
</main>
${pathname === '/add/' || admin ? '' : `<div class="submit-bar" hidden>
  <span>Know a signing we're missing?</span>
  <a class="btn btn-accent btn-sm" href="${esc(link('/add/'))}">${ICON.plus}Submit A Signing</a>
</div>
<script>(function(){var bar=document.querySelector('.submit-bar'),top=document.querySelector('.header-actions');if(!bar||!top||!('IntersectionObserver' in window))return;new IntersectionObserver(function(e){bar.hidden=e[0].isIntersecting}).observe(top)})();</script>`}
<footer class="site-footer">
  <div class="footer-brand">
    <div class="brand">${ICON.logo}</div>
    <a class="social" href="${X_URL}" rel="me noopener" target="_blank" aria-label="Autograph Hero on X (Twitter)">${ICON.x}<span>@autographheroX</span></a>
  </div>
  <div class="footer-about">
    <h2>About Autograph Hero</h2>
    <p>Autograph Hero is a passion project built by a lifelong autograph and sports card collector. I made it so fans can find every signing, meet &amp; greet and mail-in in one place, and never miss the chance to get something signed by the people they root for. <a href="${esc(link('/about/'))}">Read the story</a> · <a href="${esc(link('/contact/'))}">Contact us</a></p>
  </div>
  <p>Listings are gathered from promoter and shop websites and refreshed every week. Dates, prices and availability can change, so always confirm with the organizer before you order or travel.</p>
  <p class="small footer-links"><a href="${esc(link('/about/'))}">About</a><a href="${esc(link('/contact/'))}">Contact</a><a href="${esc(link('/archive/'))}">Signing Archives</a><a href="${esc(link('/autographs/'))}">Signers A–Z</a><a href="${esc(link('/teams/'))}">Teams A–Z</a><a href="${esc(link('/account/'))}">Log In</a><a href="${esc(link('/app/'))}">Get the App</a><a href="${esc(link('/terms/'))}">Terms</a><a href="${esc(link('/privacy/'))}">Privacy</a><a href="${esc(link('/photo-credits/'))}">Photo credits</a></p>
  <p class="mono small">Updated ${esc(longDate(TODAY))}</p>
</footer>
${script ? `<script src="${esc(asset('/assets/site.js'))}" defer></script>` : ''}
${forms ? `<script src="${esc(asset('/assets/forms.js'))}" defer></script>` : ''}
${captcha ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ''}
${account ? `<script src="${esc(asset('/assets/account.js'))}" defer></script>` : ''}
${remind ? `<script src="${esc(asset('/assets/remind.js'))}" defer></script>` : ''}
${admin ? `<script src="${esc(asset('/assets/admin.js'))}" defer></script>` : `<script src="${esc(asset('/assets/app.js'))}" defer></script>`}
${COUNT_VISITS && !admin && !NOINDEX ? `<script>try{navigator.sendBeacon(${JSON.stringify(`${SUPABASE_URL}/functions/v1/site-visit`)})}catch(e){}</script>` : ''}
${CF_ANALYTICS_TOKEN && !admin ? `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon="${esc(JSON.stringify({ token: CF_ANALYTICS_TOKEN }))}"></script>` : ''}
</body>
</html>
`;
}

// ---------- pages ----------

function homePage(list) {
  const sports = countBy(list, (s) => s.sport);
  const states = countBy(list, (s) => s.state);
  // 11 cards + the "See more" card = 12, which fills complete rows at 4, 3, 2 or 1 per row.
  const soon = list.slice(0, 11);

  // The hero ticket is a sign-up pass, not a signing: live counts on top, a "who do you
  // collect?" box below that carries the favorite over to the Sign Up page (?fav=).
  const athleteCount = new Set(list.flatMap((s) => s.names.map((n) => n.toLowerCase()))).size;
  const mailCount = list.filter((s) => s.type === 'mail-in').length;
  const suggest = [...new Set(list.flatMap((s) => [...s.names, ...(s.teams || [])]))]
    .filter((o) => typeof o === 'string' && o.trim()).sort((a, b) => a.localeCompare(b)).slice(0, 300);
  const stat = (n, label) => `<div class="pass-stat"><span class="pass-num">${n}</span><span class="pass-label">${label}</span></div>`;
  const feature = `<div class="feature pass">
      <div class="pass-top">
        <span class="badge badge-public">Fan pass</span>
        <div class="pass-stats">
          ${stat(list.length, `Upcoming signing${list.length === 1 ? '' : 's'}`)}
          ${stat(athleteCount, `Athlete${athleteCount === 1 ? '' : 's'}`)}
          ${stat(mailCount, 'By mail')}
        </div>
      </div>
      <div class="tear"></div>
      <form class="feature-body pass-form" action="${esc(link('/signup/'))}" method="get">
        <div class="feature-name">Never Miss A Signing</div>
        <p class="muted">Tell us who you collect. We'll email you when they sign.</p>
        <label class="sr-only" for="pass-fav">Favorite team, player or person</label>
        <div class="pass-row">
          <input id="pass-fav" name="fav" type="text" list="pass-fav-list" placeholder="Team, player or person" autocomplete="off" maxlength="80">
          <button class="btn btn-accent" type="submit">${ICON.bell}Sign Up</button>
        </div>
        <datalist id="pass-fav-list">${suggest.map((o) => `<option value="${esc(o)}">`).join('')}</datalist>
      </form>
    </div>`;

  const body = `
<section class="hero">
  <div class="hero-top">
    <div class="hero-copy">
      <div class="eyebrow">Signings · Meet &amp; greets · Mail-ins</div>
      <h1>Meet the people <span class="accent">you root for.</span></h1>
      <p class="lede">Find upcoming autograph signings with athletes and celebrities, in person or by mail. See dates, prices and order deadlines in one place, then save them to your calendar.</p>
    </div>
    ${feature}
  </div>
  <form class="search" role="search" action="${esc(link('/events/'))}" method="get">
    <div class="field grow">
      <label for="h-q">Who</label>
      <input id="h-q" name="q" type="search" placeholder="Player, team or city" autocomplete="off">
    </div>
    <div class="field">
      <label for="h-type">How</label>
      <select id="h-type" name="type">
        <option value="">Any type</option>
        <option value="public">In person</option>
        <option value="mail-in">Mail-in</option>
        <option value="private">Private signing</option>
      </select>
    </div>
    <div class="field">
      <label for="h-state">Where</label>
      <select id="h-state" name="state">
        <option value="">Any state</option>
        ${states.map(([st]) => `<option value="${esc(st)}">${esc(st)}</option>`).join('')}
      </select>
    </div>
    <button class="btn btn-accent" type="submit">${ICON.search}Search signings</button>
  </form>
</section>

<section class="band">
  <div class="section-head">
    <div>
      <h2>Coming up</h2>
      <p class="muted">${list.length} upcoming signing${list.length === 1 ? '' : 's'}, soonest first.</p>
    </div>
    <a class="more" href="${esc(link('/events/'))}">See all signings ${ICON.arrow}</a>
  </div>
  ${soon.length ? `<div class="grid grid-feed">${soon.map(card).join('\n')}
${moreCard(list.length, list.length - soon.length)}</div>` : '<p class="empty">No upcoming signings are listed right now. Check back after the next weekly update.</p>'}
</section>

${sports.length ? `<section class="band band-alt">
  <div class="section-head"><h2>Browse by sport</h2></div>
  <div class="tiles">
    ${sports.map(([sp, n]) => `<a class="tile" href="${esc(link(sportPath(sp)))}"><span class="tile-name">${esc(sp)}</span><span class="mono">${n} signing${n === 1 ? '' : 's'} ${ICON.arrow}</span></a>`).join('\n    ')}
  </div>
</section>` : ''}

<section class="band">
  <div class="cta-pair">
    <div class="cta cta-dark">
      <div class="eyebrow">Alerts</div>
      <h2>Never miss your favorites</h2>
      <p>Tell us your favorite teams, players and people. We'll email you when one of them has a signing.</p>
      <a class="btn btn-accent" href="${esc(link('/signup/'))}">${ICON.bell}Sign Up</a>
    </div>
    <div class="cta">
      <div class="eyebrow">Built by fans</div>
      <h2>Know about one we missed?</h2>
      <p>Send us a signing or meet &amp; greet. We check every listing before it goes on the calendar.</p>
      <a class="btn btn-ink" href="${esc(link('/add/'))}">${ICON.plus}Submit A Signing</a>
    </div>
  </div>
</section>

<section class="band">
  <div class="section-head"><h2>Three ways to get it signed</h2></div>
  <div class="steps">
    <div class="step"><div class="step-n">01</div><h3>In person</h3><p>${esc(TYPE_BLURB.public)}</p></div>
    <div class="step"><div class="step-n">02</div><h3>Private signing</h3><p>${esc(TYPE_BLURB.private)}</p></div>
    <div class="step"><div class="step-n">03</div><h3>Mail-in</h3><p>${esc(TYPE_BLURB['mail-in'])}</p></div>
  </div>
</section>`;

  return page({
    title: '',
    description: `Find ${list.length} upcoming autograph signings, meet & greets and mail-in signings with athletes and celebrities. Dates, prices and order deadlines, plus email alerts for your favorites.`,
    pathname: '/',
    body,
    ld: [
      {
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: SITE_NAME,
        url: abs('/'),
        potentialAction: { '@type': 'SearchAction', target: { '@type': 'EntryPoint', urlTemplate: `${abs('/events/')}?q={search_term_string}` }, 'query-input': 'required name=search_term_string' },
      },
      { '@context': 'https://schema.org', '@type': 'Organization', name: SITE_NAME, url: abs('/'), logo: abs('/assets/email-logo.png'), sameAs: [X_URL] },
    ],
  });
}

function countBy(list, fn) {
  const m = new Map();
  for (const s of list) {
    const k = fn(s);
    if (k) m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

function eventsPage(list) {
  const sports = countBy(list, (s) => s.sport);
  const states = countBy(list, (s) => s.state).sort((a, b) => a[0].localeCompare(b[0]));
  const types = countBy(list, (s) => s.type);
  const body = `
<section class="page-head">
  <div class="eyebrow accent">All signings</div>
  <h1>Upcoming signings</h1>
</section>
<section class="band band-tight">
  <form class="filters" id="filters" role="search">
    <div class="field grow">
      <label for="f-q">Search</label>
      <input id="f-q" name="q" type="search" placeholder="Player, team or city" autocomplete="off">
    </div>
    <div class="field">
      <label for="f-type">Type</label>
      <select id="f-type" name="type">
        <option value="">Any type</option>
        ${types.map(([t]) => `<option value="${esc(t)}">${esc(TYPE_LABEL[t])}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label for="f-sport">Sport</label>
      <select id="f-sport" name="sport">
        <option value="">Any sport</option>
        ${sports.map(([sp]) => `<option value="${esc(sp)}">${esc(sp)}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label for="f-state">State</label>
      <select id="f-state" name="state">
        <option value="">Any state</option>
        ${states.map(([st]) => `<option value="${esc(st)}">${esc(st)}</option>`).join('')}
      </select>
    </div>
    <button class="btn btn-ghost" type="reset">Clear</button>
  </form>
  <p class="muted" id="count" aria-live="polite">${list.length} signing${list.length === 1 ? '' : 's'}</p>
  <div class="grid" id="results">${list.map((s, i) => (i === 7 ? submitPrompt() : '') + card(s)).join('\n')}${list.length <= 7 ? submitPrompt() : ''}</div>
  <div class="empty" id="empty" hidden>
    <p><strong>No signings match those filters.</strong> Try clearing one, or if you know about a signing we don't have, add it.</p>
    <a class="btn btn-accent" href="${esc(link('/add/'))}">${ICON.plus}Submit A Signing</a>
  </div>
</section>`;
  return page({
    title: 'Upcoming Autograph Signings and Meet & Greets',
    description: `Browse ${list.length} upcoming autograph signings. Filter by athlete, sport, state or signing type.`,
    pathname: '/events/',
    body,
    script: true,
  });
}

function calendarFor(s) {
  const date = s.eventDate || (s.deadline && !s.deadlinePassed ? s.deadline : null);
  if (!date) return null;
  const isDeadline = !s.eventDate;
  const title = isDeadline ? `Order deadline: ${s.name} autograph signing` : `${s.name} autograph signing`;
  const details = [
    s.timeText ? `Time: ${s.timeText}` : null,
    s.deadline && !isDeadline ? `Order deadline: ${longDate(s.deadline)}` : null,
    s.listingUrl ? `Details: ${s.listingUrl}` : null,
    'Confirm details with the organizer before you go.',
  ].filter(Boolean).join('\n');
  const g = new URLSearchParams({ action: 'TEMPLATE', text: title, dates: `${compact(date)}/${compact(nextDay(date))}`, details });
  if (s.location) g.set('location', s.location);
  const ics = (v) => String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
  const file = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Autograph Hero//EN', 'BEGIN:VEVENT',
    `UID:signing-${s.id}@autographhero.com`,
    `DTSTAMP:${compact(TODAY)}T000000Z`,
    `DTSTART;VALUE=DATE:${compact(date)}`,
    `DTEND;VALUE=DATE:${compact(nextDay(date))}`,
    `SUMMARY:${ics(title)}`,
    `DESCRIPTION:${ics(details)}`,
    s.location ? `LOCATION:${ics(s.location)}` : null,
    // The calendar app's own reminder: 9 AM the day before (the event is all-day, starting at midnight).
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${ics(isDeadline ? `Order deadline tomorrow: ${s.name}` : `Tomorrow: ${s.name} autograph signing`)}`, 'TRIGGER:-PT15H', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n') + '\r\n';
  return { google: `https://calendar.google.com/calendar/render?${g}`, file, isDeadline };
}

// Search result title and summary for a signing: who, what kind, where and when, and the price.
const KIND = { public: 'Autograph Signing', private: 'Private Signing', 'mail-in': 'Mail-In Signing', unknown: 'Autograph Signing' };
function signingMeta(s) {
  const where = s.type === 'public' && s.place ? ` in ${s.place}` : '';
  const title = `${s.name} ${KIND[s.type]}${where}${s.eventDate ? ` (${mdy(s.eventDate)})` : ''}`;
  const venue = s.venue ? s.venue.split(',')[0] : null;
  const on = s.eventDate ? ` on ${shortDate(s.eventDate)}${s.timeText && s.type === 'public' ? `, ${s.timeText}` : ''}` : '';
  const by = s.deadline && !s.deadlinePassed && s.deadline !== s.eventDate ? ` Order by ${fmt(s.deadline, { month: 'short', day: 'numeric' })}.` : '';
  const lead = {
    public: `Meet ${s.name}${venue ? ` at ${venue}` : ''}${s.place ? `, ${s.place}` : ''}${on}.`,
    private: `${s.name} private signing${s.source ? ` with ${s.source}` : ''}${on}: send in your item and get it signed.`,
    'mail-in': `Get an autograph from ${s.name} by mail${s.source ? ` through ${s.source}` : ''}${on}.`,
    unknown: `${s.name} autograph signing${on}.`,
  }[s.type];
  const price = s.priceMin ? ` Autographs from ${s.priceMin}.` : '';
  if (s.past) {
    return {
      title: `${title} – Past Signing`,
      description: `Past signing: ${lead.replace(/^Meet /, 'Fans met ').replace(/^Get an autograph from /, 'Autographs from ')}${price.replace('from', 'were from')} See what's coming up next.`,
      image: s.photo?.url || null,
      imageAlt: s.name,
    };
  }
  return {
    title,
    description: `${lead}${by}${price}`,
    image: s.photo?.url || null,
    imageAlt: s.name,
  };
}

// schema.org Event, which lets Google show the signing in event search results. Only for
// in-person signings with a date and a place; mail-ins aren't events you can go to.
function eventLd(s) {
  if (s.type !== 'public' || !s.eventDate || !(s.venue || s.city)) return null;
  const us = s.state && US_STATES.includes(s.state);
  const offer = s.listingUrl
    ? s.priceLow !== null && s.priceHigh !== null && s.priceHigh > s.priceLow
      ? { '@type': 'AggregateOffer', url: s.listingUrl, lowPrice: s.priceLow, highPrice: s.priceHigh, priceCurrency: 'USD' }
      : { '@type': 'Offer', url: s.listingUrl, ...(s.priceLow !== null ? { price: s.priceLow, priceCurrency: 'USD' } : {}), availability: 'https://schema.org/InStock' }
    : undefined;
  return {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: `${s.name} Autograph Signing`,
    description: signingMeta(s).description,
    startDate: s.eventDate,
    endDate: s.eventDate,
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: {
      '@type': 'Place',
      name: s.venue || s.place,
      address: { '@type': 'PostalAddress', addressLocality: s.city || undefined, addressRegion: s.state || undefined, addressCountry: us ? 'US' : undefined },
    },
    image: s.photo ? [s.photo.url] : undefined,
    url: abs(`/signing/${s.slug}/`),
    performer: s.names.length ? s.names.map((n) => ({ '@type': 'Person', name: n })) : undefined,
    organizer: s.source ? { '@type': 'Organization', name: s.source, url: s.listingUrl ? new URL(s.listingUrl).origin : undefined } : undefined,
    offers: offer,
  };
}

// Whether "Email me a reminder" makes sense: mail-in and private signings remind before the order
// deadline (so only while it's open); others before the signing day. signing-reminders decides the exact time.
function remindable(s) {
  if (s.past) return false;
  if ((s.type === 'mail-in' || s.type === 'private') && s.deadline) return !s.deadlinePassed;
  return Boolean((s.eventDate && s.eventDate >= TODAY) || (s.deadline && !s.deadlinePassed));
}

function remindBox(s) {
  const deadline = (s.type === 'mail-in' || s.type === 'private') && s.deadline;
  const when = deadline ? 'the day before the order deadline' : 'the day before';
  return `<div class="remind" data-remind data-signing="${esc(s.id)}" data-endpoint="${esc(REMIND_URL)}" data-path="${esc(BASE)}" data-supabase="${esc(SUPABASE_URL)}" data-key="${esc(SUPABASE_KEY)}"${TURNSTILE_SITE_KEY ? ` data-sitekey="${esc(TURNSTILE_SITE_KEY)}"` : ''}>
        <button class="btn btn-ghost btn-block" type="button" data-remind-open>${ICON.bell}Email me a reminder</button>
        <form class="remind-form" data-remind-form hidden novalidate>
          <label for="remind-email-${esc(s.id)}">Email me ${esc(when)}</label>
          <div class="remind-row">
            <input id="remind-email-${esc(s.id)}" name="email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" required>
            <button class="btn btn-accent" type="submit">Remind me</button>
          </div>
          <div class="hp" aria-hidden="true"><label for="remind-website-${esc(s.id)}">Leave this empty</label><input id="remind-website-${esc(s.id)}" name="website" type="text" tabindex="-1" autocomplete="off"></div>
          <div class="remind-captcha"></div>
          <p class="small muted">One email about this signing. No newsletter, and you can cancel from the confirmation email.</p>
        </form>
        <p class="f-status" role="status" aria-live="polite" hidden></p>
      </div>`;
}

function signingPage(s, list) {
  const cal = s.past ? null : calendarFor(s);
  // 5 related + the "See more" card = 6, which fills complete rows at 3, 2 or 1 per row.
  const more = list.filter((o) => o.id !== s.id && ((s.sport && o.sport === s.sport) || (s.state && o.state === s.state))).slice(0, 5);
  const mapUrl = s.location && s.type !== 'mail-in' ? `https://www.google.com/maps/search/?${new URLSearchParams({ api: '1', query: s.location })}` : null;
  const credit = creditLine(s.photo, 'credit-main') + creditLine(s.photoFallback, 'credit-fb', true);
  const rows = [
    s.eventDate ? ['Date', longDate(s.eventDate)] : s.eventDateText ? ['Date', s.eventDateText] : null,
    s.timeText ? ['Time', s.timeText] : null,
    s.deadline ? ['Order by', `${longDate(s.deadline)}${s.deadlinePassed ? ' (passed)' : ''}`] : null,
    s.venue ? ['Venue', s.venue] : null,
    s.place ? ['City', s.place] : null,
    s.teams.length ? [s.teams.length === 1 ? 'Team' : 'Teams', { html: s.teams.map((t) => `<a href="${esc(link(teamPath(slugify(t))))}">${esc(t)}</a>`).join(', ') }, 'wide'] : null,
  ].filter(Boolean);
  const trail = [['Home', '/'], ...(s.sport ? [[s.sport, sportPath(s.sport)]] : [['All signings', '/events/']]), [s.name, `/signing/${s.slug}/`]];

  const body = `
${crumbsNav(trail)}
<section class="detail">
  <div class="detail-main">
    <div class="detail-photo">
    ${photo(s, 'photo-large', 'main-photo')}
    ${credit}
    </div>
    <div class="detail-text">
    <h2>How this signing works</h2>
    <p class="lede">${esc(TYPE_BLURB[s.type])}</p>
    ${s.prices.length ? `<h2>Prices</h2>
    <div class="prices">${s.prices.map((p) => `<div><span>${esc(p.item).replace(/\//g, '/<wbr>')}</span><span class="mono">${esc(p.price)}</span></div>`).join('')}</div>` : ''}
    <p class="muted small">Listed from ${esc(s.source || 'the organizer')}. Autograph Hero does not sell tickets or handle orders.</p>
    <a class="inline-submit" href="${esc(link('/add/'))}">
      <span>${ICON.plus}</span>
      <span><strong>Know about another ${esc(s.names[0] || 'signing')}${s.names[0] ? ' signing' : ''}?</strong> Fans add signings we miss. Submit it and we'll put it on the calendar.</span>
    </a>
    </div>
  </div>
  <aside class="ticket">
    <div class="ticket-top">
      <div class="badges">${badge(s)}${s.sport ? `<span class="badge badge-outline">${esc(s.sport)}</span>` : ''}</div>
      <h1>${esc(s.name)}</h1>
      <p class="muted">${esc(s.title)}</p>
    </div>
    <div class="tear"></div>
    <div class="ticket-body">
      ${s.past ? `<p class="notice">This signing is over${s.sortDate ? ` (${esc(longDate(s.sortDate))})` : ''}. It's kept in the <a href="${esc(link('/archive/'))}">Signing Archives</a>.</p>`
    : s.deadlinePassed ? '<p class="notice">The order deadline listed for this signing has passed. Check with the organizer for late availability.</p>' : ''}
      <dl>${rows.map(([k, v, wide]) => `<div${wide ? ' class="wide"' : ''}><dt>${esc(k)}</dt><dd>${v?.html ?? esc(v)}</dd></div>`).join('')}</dl>
      ${s.priceMin ? `<div class="from"><span class="eyebrow">Price</span><span class="from-n">${esc(s.priceMax && s.priceMax !== s.priceMin ? `${s.priceMin} to ${s.priceMax}` : s.priceMin)}</span></div>` : ''}
      ${s.listingUrl && !s.past ? `<a class="btn btn-accent btn-block" href="${esc(s.listingUrl)}" rel="noopener" target="_blank">${s.type === 'public' ? 'Get tickets' : 'Order'} at ${esc(s.host)} ${ICON.out}</a>` : ''}
      ${cal ? `<div class="cal">
        <span class="eyebrow">${cal.isDeadline ? 'Save the order deadline' : 'Add to calendar'}</span>
        <div class="cal-row">
          <a class="btn btn-ghost" href="${esc(cal.google)}" rel="noopener" target="_blank">${ICON.cal}Google</a>
          <a class="btn btn-ghost" href="${esc(link(`/signing/${s.slug}/event.ics`))}" download="${esc(s.slug)}.ics">${ICON.cal}Apple / Outlook</a>
        </div>
        ${remindable(s) ? remindBox(s) : ''}
      </div>` : ''}
      ${mapUrl && !s.past ? `<a class="maplink" href="${esc(mapUrl)}" rel="noopener" target="_blank">${ICON.pin}Open in Google Maps</a>` : ''}
      ${s.names.length ? `<a class="maplink" href="${esc(link(`/signup/?fav=${encodeURIComponent(s.names[0])}`))}">${ICON.bell}Email me when ${esc(s.names[0])} signs again</a>` : ''}
      ${s.names.filter((n) => slugify(n)).map((n) => `<a class="maplink" href="${esc(link(signerPath(slugify(n))))}">${ICON.arrow}All ${esc(n)} signings</a>`).join('\n      ')}
      <p class="muted small">Details can change. Confirm with the organizer before you order or travel.</p>
    </div>
  </aside>
</section>
${more.length ? `<section class="band band-alt">
  <div class="section-head"><h2>More like this</h2><a class="more" href="${esc(link('/events/'))}">See all signings ${ICON.arrow}</a></div>
  <div class="grid grid-related">${more.map(card).join('\n')}
${moreCard(list.length, null, s.sport)}</div>
</section>` : ''}`;

  return {
    html: page({ ...signingMeta(s), pathname: `/signing/${s.slug}/`, body, remind: !s.past && remindable(s), ld: [breadcrumbLd(trail), s.past ? null : eventLd(s)] }),
    ics: cal ? cal.file : null,
  };
}

const field = (id, label, input, hint = '') =>
  `<div class="f-field"><label for="${id}">${label}</label>${input}${hint ? `<p class="f-hint" id="${id}-hint">${hint}</p>` : ''}</div>`;
// Cloudflare Turnstile "are you a person" check, shown on Submit a Signing and Sign Up.
// Usually a single click or nothing at all. Only appears when a site key is set.
const captchaBox = () => (TURNSTILE_SITE_KEY
  ? `<div class="f-captcha"><p class="f-label" id="captcha-label">Quick check that you're a person <span class="req">Required</span></p><div class="cf-turnstile" data-sitekey="${esc(TURNSTILE_SITE_KEY)}" data-theme="light" data-size="flexible" aria-labelledby="captcha-label"></div></div>`
  : '');
const honeypot = '<div class="hp" aria-hidden="true"><label for="f-website">Leave this empty</label><input id="f-website" name="website" type="text" tabindex="-1" autocomplete="off"></div>';
const formStatus = '<p class="f-status" role="status" aria-live="polite" hidden></p><noscript><p class="notice">This form needs JavaScript turned on.</p></noscript>';

function addPage() {
  const body = `
<section class="page-head">
  <div class="eyebrow accent">Submit a signing</div>
  <h1>Submit a signing</h1>
  <p class="lede">Know about an autograph signing, meet &amp; greet or mail-in we don't have yet? Send it in. We check every listing against its source before it goes live.</p>
</section>
<section class="band band-tight">
  <form class="f-form" data-form="listing" data-endpoint="${esc(FORMS_URL)}" novalidate>
    <fieldset>
      <legend><span class="f-n">01</span>The signing</legend>
      ${field('f-names', 'Who is signing? <span class="req">Required</span>', '<input id="f-names" name="athlete_names" type="text" required maxlength="300" autocomplete="off" aria-describedby="f-names-hint">', 'For a group signing, separate names with commas.')}
      <div class="f-row">
        ${field('f-sport', 'Sport', `<select id="f-sport" name="sport"><option value="">Choose one</option>${SPORT_CHOICES.map((x) => `<option>${x}</option>`).join('')}</select>`)}
        <div class="f-field"><span class="f-label" id="f-type-label">How does it work? <span class="req">Required</span></span>
          <div class="f-choices" role="radiogroup" aria-labelledby="f-type-label">
            <label><input type="radio" name="signing_type" value="public" required> In person</label>
            <label><input type="radio" name="signing_type" value="private"> Private signing</label>
            <label><input type="radio" name="signing_type" value="mail-in"> Mail-in</label>
          </div>
        </div>
      </div>
    </fieldset>
    <fieldset>
      <legend><span class="f-n">02</span>When and where</legend>
      <div class="f-row">
        ${field('f-date', 'Signing date', '<input id="f-date" name="event_date" type="date">')}
        ${field('f-time', 'Time', '<input id="f-time" name="event_time_text" type="text" maxlength="120" placeholder="e.g. 1pm to 3pm">')}
        ${field('f-deadline', 'Order deadline', '<input id="f-deadline" name="order_deadline" type="date" aria-describedby="f-deadline-hint">', 'For mail-in and private signings. Enter a signing date, a deadline, or both.')}
      </div>
      ${field('f-venue', 'Venue', '<input id="f-venue" name="venue" type="text" maxlength="200" placeholder="Card shop, convention center, stadium…">')}
      <div class="f-row">
        ${field('f-city', 'City', '<input id="f-city" name="city" type="text" maxlength="100">')}
        ${field('f-state', 'State', `<select id="f-state" name="state"><option value="">Choose one</option>${US_STATES.map((x) => `<option>${x}</option>`).join('')}</select>`)}
      </div>
    </fieldset>
    <fieldset>
      <legend><span class="f-n">03</span>Details</legend>
      ${field('f-url', 'Link to the official announcement or order page <span class="req">Required</span>', '<input id="f-url" name="source_url" type="url" required maxlength="1000" placeholder="https://" aria-describedby="f-url-hint">', 'A post or page from the promoter, venue, team or the person signing. This is how we confirm it.')}
      ${field('f-prices', 'Prices', '<textarea id="f-prices" name="price_text" rows="3" maxlength="1000" placeholder="Autograph $40, photo op $50…"></textarea>')}
      ${field('f-notes', 'Anything else we should know?', '<textarea id="f-notes" name="notes" rows="3" maxlength="2000"></textarea>')}
    </fieldset>
    <fieldset>
      <legend><span class="f-n">04</span>About you</legend>
      <div class="f-row">
        ${field('f-name', 'Your name', '<input id="f-name" name="submitter_name" type="text" maxlength="120" autocomplete="name">')}
        ${field('f-email', 'Your email <span class="req">Required</span>', '<input id="f-email" name="submitter_email" type="email" required maxlength="254" autocomplete="email" aria-describedby="f-email-hint">', 'Only used if we have a question about this listing.')}
      </div>
    </fieldset>
    ${honeypot}
    ${captchaBox()}
    <div class="f-actions"><button class="btn btn-accent" type="submit">Send for review</button></div>
    ${formStatus}
  </form>
</section>`;
  return page({ title: 'Submit a signing', description: 'Send us an autograph signing or meet & greet we are missing. Every listing is checked before it goes live.', pathname: '/add/', body, forms: true, captcha: Boolean(TURNSTILE_SITE_KEY) });
}

// Suggestions for the favorites boxes: every team and every signer we know of.
function favOptions(list, athletes) {
  const options = new Set();
  for (const rows of athletes.values()) for (const a of rows) {
    if (a.name) options.add(a.name);
    for (const t of Array.isArray(a.teams) ? a.teams : []) if (t?.team) options.add(t.team);
  }
  for (const s of list) for (const n of s.names) options.add(n);
  return [...options].filter((o) => typeof o === 'string' && o.trim()).sort((a, b) => a.localeCompare(b));
}

function signupPage(list, athletes) {
  const sorted = favOptions(list, athletes);
  const body = `
<section class="page-head">
  <div class="eyebrow accent">Sign up</div>
  <h1>Never miss your favorites</h1>
  <p class="lede">Tell us who you follow. When one of your favorite teams, players or people has a signing, we'll send you an email.</p>
</section>
<section class="band band-tight">
  <form class="f-form f-narrow" data-form="signup" data-endpoint="${esc(FORMS_URL)}" data-supabase="${esc(SUPABASE_URL)}" data-key="${esc(SUPABASE_KEY)}" data-account="${esc(link('/account/'))}" novalidate>
    <fieldset>
      <legend><span class="f-n">01</span>Your account</legend>
      <div class="f-row">
        ${field('s-name', 'Name <span class="req">Required</span>', '<input id="s-name" name="name" type="text" required maxlength="120" autocomplete="name">')}
        ${field('s-email', 'Email (your login) <span class="req">Required</span>', '<input id="s-email" name="email" type="email" required maxlength="254" autocomplete="username">')}
      </div>
      <div class="f-row">
        ${field('s-pass', 'Password <span class="req">Required</span>', '<input id="s-pass" name="password" type="password" required minlength="8" maxlength="72" autocomplete="new-password" aria-describedby="s-pass-hint">', 'At least 8 characters.')}
        ${field('s-pass2', 'Password again <span class="req">Required</span>', '<input id="s-pass2" name="password2" type="password" required maxlength="72" autocomplete="new-password">')}
      </div>
    </fieldset>
    <fieldset>
      <legend><span class="f-n">02</span>Your favorites</legend>
      <div class="f-field">
        <label for="s-fav">Add a team, player or person <span class="req">At least one</span></label>
        <p class="f-hint fav-how" id="s-fav-hint">Choose from the list or add your own manually, then press Add. You can add up to 25.</p>
        <div class="fav-entry">
          <input id="s-fav" type="text" list="fav-options" maxlength="80" autocomplete="off" placeholder="e.g. Denver Broncos or John Elway" aria-describedby="s-fav-hint">
          <button class="btn btn-ghost" type="button" data-fav-add>Add</button>
        </div>
        <datalist id="fav-options">${sorted.map((o) => `<option value="${esc(o)}"></option>`).join('')}</datalist>
        <ul class="fav-list" aria-label="Your favorites" data-fav-list></ul>
      </div>
    </fieldset>
    <label class="f-check"><input type="checkbox" name="consent" required checked> Email me when my favorites have a signing. I can unsubscribe at any time.</label>
    ${honeypot}
    ${captchaBox()}
    <div class="f-actions"><button class="btn btn-accent" type="submit">${ICON.bell}Sign Up</button></div>
    ${formStatus}
    <p class="muted small">Already have an account? <a href="${esc(link('/account/'))}">Log in</a> to change your favorites. See our <a href="${esc(link('/privacy/'))}">privacy policy</a>.</p>
  </form>
</section>`;
  return page({ title: 'Sign up', description: 'Sign up to get an email when your favorite teams, players and people have an autograph signing.', pathname: '/signup/', body, forms: true, captcha: Boolean(TURNSTILE_SITE_KEY) });
}

// Member login and account. Static HTML; assets/account.js switches between the
// "send me a login link" form and the account editor once the emailed link is used.
function accountPage(list, athletes) {
  const sorted = favOptions(list, athletes);
  // "Your Feed": every upcoming signing is in the page (hidden), tagged with its signers and
  // their teams; account.js shows the ones that match the member's favorites, soonest first.
  const feedCards = list.map((s) => {
    const terms = [...s.names, ...(s.teams || [])].map((t) => String(t).toLowerCase().trim()).filter(Boolean).join('|');
    return card(s).replace('<a class="card" ', `<a class="card" hidden data-terms="${esc(terms)}" `);
  }).join('\n');
  const pw = (id, name, label, auto, hint = '') =>
    field(id, label, `<input id="${id}" name="${name}" type="password" required ${auto === 'new-password' ? 'minlength="8" ' : ''}maxlength="72" autocomplete="${auto}"${hint ? ` aria-describedby="${id}-hint"` : ''}>`, hint);
  const body = `
<section class="page-head" data-account-head hidden>
  <div class="eyebrow accent">Members</div>
  <h1 data-account-title>Log in</h1>
  <p class="lede" data-account-lede>Log in with the email and password you signed up with.</p>
</section>
<section class="band band-tight" data-account data-supabase="${esc(SUPABASE_URL)}" data-key="${esc(SUPABASE_KEY)}" data-endpoint="${esc(FORMS_URL)}" data-path="${esc(BASE)}">
  <form class="f-form login-split" data-view="login" novalidate>
    <div class="login-hello">
      <h1 class="login-hello-big">Welcome back</h1>
      <p class="login-hello-sub">Never Miss Another Autograph</p>
    </div>
    <fieldset>
      <legend>Log in</legend>
      ${field('a-email', 'Email', '<input id="a-email" name="email" type="email" required maxlength="254" autocomplete="username">')}
      ${pw('a-pass', 'password', 'Password', 'current-password')}
      <div class="f-actions"><button class="btn btn-accent" type="submit">${ICON.user}Log in</button><button class="btn btn-ghost" type="button" data-show="forgot">Forgot password?</button></div>
      <p class="f-status" role="status" aria-live="polite" hidden></p>
    </fieldset>
    <p class="muted small login-note">No account yet? <a href="${esc(link('/signup/'))}">Sign up</a> to get alerts when your favorites have a signing.</p>
  </form>

  <form class="f-form f-narrow" data-view="forgot" novalidate hidden>
    <fieldset>
      <legend>Forgot your password?</legend>
      <p class="muted">Enter the email you signed up with and we'll send you a link to set a new password.</p>
      ${field('r-email', 'Email', '<input id="r-email" name="email" type="email" required maxlength="254" autocomplete="username">')}
      ${honeypot}
      <div class="f-actions"><button class="btn btn-accent" type="submit">Email me a link</button><button class="btn btn-ghost" type="button" data-show="login">Back to log in</button></div>
      <p class="f-status" role="status" aria-live="polite" hidden></p>
    </fieldset>
  </form>

  <form class="f-form f-narrow" data-view="setpw" novalidate hidden>
    <fieldset>
      <legend>Set a new password</legend>
      ${pw('n-pass', 'password', 'New password', 'new-password', 'At least 8 characters.')}
      ${pw('n-pass2', 'password2', 'New password again', 'new-password')}
      <div class="f-actions"><button class="btn btn-accent" type="submit">Save password</button></div>
      <p class="f-status" role="status" aria-live="polite" hidden></p>
    </fieldset>
  </form>

  <p class="notice" data-view="loading" hidden>Loading…</p>

  <div class="member" data-view="account" hidden>
    <p class="f-status" role="status" aria-live="polite" data-account-status hidden></p>
    <div class="member-tabs" role="tablist" aria-label="Your account">
      <button role="tab" type="button" id="tab-feed" aria-controls="pane-feed" aria-selected="true" data-tab="feed">Your Feed</button>
      <button role="tab" type="button" id="tab-prefs" aria-controls="pane-prefs" aria-selected="false" data-tab="prefs">Change Preferences</button>
      <button class="btn btn-ghost btn-sm member-logout" type="button" data-logout>Log out</button>
    </div>
    <div class="member-pane" role="tabpanel" id="pane-feed" aria-labelledby="tab-feed" data-pane="feed">
      <div class="feed-head">
        <p class="feed-count" data-feed-count></p>
        <ul class="feed-favs" aria-label="Your favorites" data-feed-favs></ul>
      </div>
      <div class="grid grid-feed" data-feed>${feedCards}</div>
      <div class="empty" data-feed-empty hidden>
        <p><strong>No upcoming signings for your favorites right now.</strong> We'll email you as soon as one is added.</p>
        <div class="f-actions"><button class="btn btn-accent" type="button" data-tab="prefs">Add more favorites</button><a class="btn btn-ghost" href="${esc(link('/events/'))}">See all signings</a></div>
      </div>
    </div>
  <form class="f-form f-narrow member-pane" role="tabpanel" id="pane-prefs" aria-labelledby="tab-prefs" data-pane="prefs" data-account-form novalidate hidden>
    <fieldset>
      <legend><span class="f-n">01</span>Your details</legend>
      <div class="f-row">
        ${field('m-name', 'Name', '<input id="m-name" name="name" type="text" required maxlength="120" autocomplete="name">')}
        <div class="f-field"><span class="f-label">Email (your login)</span><p class="account-email" data-email></p></div>
      </div>
    </fieldset>
    <fieldset>
      <legend><span class="f-n">02</span>Your favorites</legend>
      <div class="f-field">
        <label for="m-fav">Add a team, player or person</label>
        <p class="f-hint fav-how" id="m-fav-hint">Choose from the list or add your own manually, then press Add.</p>
        <div class="fav-entry">
          <input id="m-fav" type="text" list="m-fav-options" maxlength="80" autocomplete="off" placeholder="e.g. Denver Broncos or John Elway" aria-describedby="m-fav-hint">
          <button class="btn btn-ghost" type="button" data-fav-add>Add</button>
        </div>
        <datalist id="m-fav-options">${sorted.map((o) => `<option value="${esc(o)}"></option>`).join('')}</datalist>
        <ul class="fav-list" aria-label="Your favorites" data-fav-list></ul>
      </div>
      <label class="f-check"><input type="checkbox" name="alerts"> Email me when my favorites have a signing.</label>
    </fieldset>
    <div class="f-actions">
      <button class="btn btn-accent" type="submit">Save changes</button>
    </div>
    <p class="f-status" role="status" aria-live="polite" data-save-status hidden></p>
    <fieldset data-change-pw>
      <legend><span class="f-n">03</span>Change password</legend>
      <div class="f-row">
        ${pw('c-pass', 'newpassword', 'New password', 'new-password', 'At least 8 characters.')}
        ${pw('c-pass2', 'newpassword2', 'New password again', 'new-password')}
      </div>
      <div class="f-actions"><button class="btn btn-ghost" type="button" data-change-pw-save>Change password</button></div>
      <p class="f-status" role="status" aria-live="polite" data-pw-status hidden></p>
    </fieldset>
    <div class="danger-zone">
      <h2>Delete my account</h2>
      <p class="muted">This removes your name, email, password and favorites from Autograph Hero for good. You can sign up again any time.</p>
      <div class="f-actions">
        <button class="btn btn-ghost btn-danger" type="button" data-delete>Delete my account</button>
        <button class="btn btn-danger-solid" type="button" data-delete-confirm hidden>Yes, delete everything</button>
        <button class="btn btn-ghost" type="button" data-delete-cancel hidden>Keep my account</button>
      </div>
    </div>
  </form>
  </div>
  <noscript><p class="notice">Logging in needs JavaScript turned on.</p></noscript>
</section>`;
  return page({ title: 'Log in', description: 'Log in to change your favorite teams and players, pause alerts or delete your account.', pathname: '/account/', body, account: true, noindex: 'follow' });
}

// Owner's review page. Static shell; assets/admin.js logs in with email + password
// (Supabase Auth) and calls admin_queue / admin_decide, which refuse anyone whose
// login doesn't carry the admin role. Not linked from the site, not indexed.
function adminPage() {
  const body = `
<section class="page-head">
  <div class="eyebrow accent">Admin</div>
  <h1 data-admin-title>Admin log in</h1>
</section>
<section class="band band-tight" data-admin data-supabase="${esc(SUPABASE_URL)}" data-key="${esc(SUPABASE_KEY)}" data-site="${esc(link('/'))}" data-analytics="${esc(`${SUPABASE_URL}/functions/v1/admin-analytics`)}">
  <form class="f-form f-narrow" data-view="login" novalidate>
    <fieldset>
      <legend>Log in to review signings</legend>
      ${field('ad-email', 'Email', '<input id="ad-email" name="email" type="email" required maxlength="254" autocomplete="username">')}
      ${field('ad-pass', 'Password', '<input id="ad-pass" name="password" type="password" required maxlength="200" autocomplete="current-password">')}
      <div class="f-actions"><button class="btn btn-accent" type="submit">Log in</button></div>
      <p class="f-status" role="status" aria-live="polite" hidden></p>
    </fieldset>
  </form>
  <p class="notice" data-view="loading" hidden>Loading…</p>
  <div class="admin" data-view="panel" hidden>
    <div class="admin-bar">
      <div class="admin-tabs" role="tablist">
        <button role="tab" type="button" data-tab="pending" aria-selected="true">Waiting <span class="admin-count" data-count="pending"></span></button>
        <button role="tab" type="button" data-tab="reviewed" aria-selected="false">Reviewed</button>
        <button role="tab" type="button" data-tab="fans" aria-selected="false">Sign-ups <span class="admin-count" data-count="fans"></span></button>
        <button role="tab" type="button" data-tab="analytics" aria-selected="false">Analytics</button>
        <button role="tab" type="button" data-tab="settings" aria-selected="false">Password</button>
      </div>
      <div class="admin-actions">
        <button class="btn btn-ghost btn-sm" type="button" data-refresh>Refresh</button>
        <button class="btn btn-ghost btn-sm" type="button" data-logout>Log out</button>
      </div>
    </div>
    <p class="f-status" role="status" aria-live="polite" data-panel-status hidden></p>
    <div data-pane="pending"></div>
    <div data-pane="reviewed" hidden></div>
    <div data-pane="fans" hidden></div>
    <div data-pane="analytics" hidden></div>
    <form class="f-form f-narrow" data-pane="settings" hidden novalidate>
      <fieldset>
        <legend>Change your password</legend>
        ${field('ad-new', 'New password', '<input id="ad-new" name="password" type="password" minlength="10" maxlength="200" autocomplete="new-password" aria-describedby="ad-new-hint">', 'At least 10 characters.')}
        ${field('ad-new2', 'New password again', '<input id="ad-new2" name="password2" type="password" maxlength="200" autocomplete="new-password">')}
        <div class="f-actions"><button class="btn btn-accent" type="submit">Change password</button></div>
        <p class="f-status" role="status" aria-live="polite" hidden></p>
      </fieldset>
    </form>
  </div>
  <noscript><p class="notice">The admin page needs JavaScript turned on.</p></noscript>
</section>`;
  return page({ title: 'Admin', description: 'Autograph Hero admin.', pathname: '/admin/', body, admin: true });
}

// "Stop these emails" link from alert emails: /unsubscribe/?t=<token>. A button (not the
// link itself) turns alerts off, so email scanners that open links can't unsubscribe anyone.
function unsubscribePage() {
  const body = `
<section class="page-head">
  <div class="eyebrow accent">Alerts</div>
  <h1>Stop alert emails?</h1>
  <p class="lede">You'll stop getting emails about signings for your favorites. Your account stays, and you can turn alerts back on any time.</p>
</section>
<section class="band band-tight">
  <div class="f-form f-narrow" data-unsub data-endpoint="${esc(FORMS_URL)}">
    <div class="f-actions">
      <button class="btn btn-accent" type="button" data-unsub-go>Yes, stop alert emails</button>
      <a class="btn btn-ghost" href="${esc(link('/account/'))}">Change my favorites instead</a>
    </div>
    <p class="f-status" role="status" aria-live="polite" hidden></p>
    <noscript><p class="notice">This needs JavaScript. You can also turn alerts off on your <a href="${esc(link('/account/'))}">account page</a>.</p></noscript>
  </div>
</section>
<script>
(function () {
  var box = document.querySelector('[data-unsub]');
  var go = box.querySelector('[data-unsub-go]');
  var st = box.querySelector('.f-status');
  var t = new URLSearchParams(location.search).get('t') || '';
  function show(m, k) { st.hidden = false; st.className = 'f-status ' + (k || ''); st.textContent = m; }
  if (!t) { go.disabled = true; show("This link is missing its code. You can turn alerts off on your account page.", 'is-error'); return; }
  go.addEventListener('click', function () {
    go.disabled = true;
    show('Working…', '');
    fetch(box.getAttribute('data-endpoint'), { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ form: 'unsubscribe', token: t }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (r) { show((r && r.message) || 'Something went wrong. Please try again.', r && r.ok ? 'is-success' : 'is-error'); if (!(r && r.ok)) go.disabled = false; })
      .catch(function () { show("We couldn't reach the server. Please try again.", 'is-error'); go.disabled = false; });
  });
})();
</script>`;
  return page({ title: 'Stop alert emails', description: 'Stop Autograph Hero alert emails.', pathname: '/unsubscribe/', body, admin: false, noindex: true });
}

// The cancel link in a reminder's confirmation email: /reminder/?cancel=<token>.
function reminderPage() {
  const body = `
<section class="page-head">
  <div class="eyebrow accent">Reminders</div>
  <h1>Cancel this reminder?</h1>
  <p class="lede">You won't get the reminder email for this signing. Nothing else changes.</p>
</section>
<section class="band band-tight">
  <div class="f-form f-narrow" data-cancel data-endpoint="${esc(REMIND_URL)}">
    <div class="f-actions">
      <button class="btn btn-accent" type="button" data-cancel-go>Yes, cancel it</button>
      <a class="btn btn-ghost" href="${esc(link('/events/'))}">Keep it and see signings</a>
    </div>
    <p class="f-status" role="status" aria-live="polite" hidden></p>
    <noscript><p class="notice">This needs JavaScript turned on.</p></noscript>
  </div>
</section>
<script>
(function () {
  var box = document.querySelector('[data-cancel]');
  var go = box.querySelector('[data-cancel-go]');
  var st = box.querySelector('.f-status');
  var t = new URLSearchParams(location.search).get('cancel') || '';
  function show(m, k) { st.hidden = false; st.className = 'f-status ' + (k || ''); st.textContent = m; }
  if (!t) { go.disabled = true; show('This link is missing its code. Open the link from your confirmation email again.', 'is-error'); return; }
  go.addEventListener('click', function () {
    go.disabled = true;
    show('Working…', '');
    fetch(box.getAttribute('data-endpoint'), { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ form: 'cancel_reminder', token: t }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (r) { show((r && r.message) || 'Something went wrong. Please try again.', r && r.ok ? 'is-success' : 'is-error'); if (!(r && r.ok)) go.disabled = false; })
      .catch(function () { show("We couldn't reach the server. Please try again.", 'is-error'); go.disabled = false; });
  });
})();
</script>`;
  return page({ title: 'Cancel a reminder', description: 'Cancel an Autograph Hero reminder email.', pathname: '/reminder/', body, noindex: true });
}

// "Get the app": install steps for iPhone and Android. assets/app.js fills [data-app-panel] for the device in hand.
function appPage() {
  const body = `
<section class="page-head">
  <div class="eyebrow accent">Free · iPhone, iPad &amp; Android</div>
  <h1>Get the Autograph Hero app</h1>
  <p class="lede">Put every signing one tap from your home screen. No app store and nothing to download: it installs from your browser in a few seconds and opens full screen, like any other app.</p>
  <div class="app-panel" data-app-panel></div>
</section>
<section class="band band-tight">
  <div class="app-how">
    <div class="app-card">
      <h2 class="app-card-title">iPhone &amp; iPad</h2>
      <ol class="app-steps">
        <li>Open <strong>autographhero.com</strong> in <strong>Safari</strong>.</li>
        <li>Tap <strong>Share</strong>. Don't see it? Tap <strong>•••</strong> or <strong>☰</strong> to open the menu, then tap Share.</li>
        <li>Scroll down, tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li>
      </ol>
    </div>
    <div class="app-card">
      <h2 class="app-card-title">Android</h2>
      <ol class="app-steps">
        <li>Open <strong>autographhero.com</strong> in <strong>Chrome</strong>.</li>
        <li>Tap <strong>Install</strong> when it's offered, or the <strong>⋮</strong> menu, then <strong>Add to home screen</strong>.</li>
        <li>Find Autograph Hero with your other apps.</li>
      </ol>
    </div>
  </div>
  <p class="small muted app-foot">Pages you've opened keep working with no signal, which helps in a crowded convention hall. Listings still refresh every hour when you're online.</p>
</section>`;
  return page({ title: 'Get the App', description: 'Add Autograph Hero to your iPhone or Android home screen. Free, no app store needed.', pathname: '/app/', body });
}

// Shown by the offline worker when a page can't load and no saved copy exists.
function offlinePage() {
  const body = `
<section class="page-head">
  <div class="eyebrow accent">No connection</div>
  <h1>You're offline</h1>
  <p class="lede">Pages you've opened recently still work. Check your signal and try again. The signing will still be there.</p>
  <div class="f-actions"><button class="btn btn-accent" type="button" onclick="location.reload()">Try again</button><a class="btn btn-ghost" href="${esc(link('/'))}">Home</a></div>
</section>`;
  return page({ title: "You're offline", description: 'No connection.', pathname: '/offline/', body, noindex: true });
}

function contactLine() {
  return CONTACT_EMAIL
    ? `email us at <a href="mailto:${esc(CONTACT_EMAIL)}">${esc(CONTACT_EMAIL)}</a>`
    : `use our <a href="${esc(link('/contact/'))}">contact form</a>, or the <a href="${esc(link('/account/'))}">account page</a> to manage or delete your details`;
}

function policyPage({ title, pathname, description, eyebrow, intro, sections }) {
  const body = `
<section class="page-head">
  <div class="eyebrow accent">${esc(eyebrow)}</div>
  <h1>${esc(title)}</h1>
  <p class="mono small">Last updated ${esc(longDate(POLICY_DATE))}</p>
  <p class="lede">${intro}</p>
</section>
<section class="band band-tight">
  <div class="prose">
    ${sections.map(([h, html]) => `<h2>${esc(h)}</h2>\n${html}`).join('\n    ')}
  </div>
</section>`;
  return page({ title, description, pathname, body });
}

function privacyPage() {
  return policyPage({
    title: 'Privacy policy',
    pathname: '/privacy/',
    eyebrow: 'Privacy',
    description: 'What Autograph Hero collects, why, who helps us run the site, and how to change or delete your details.',
    intro: 'Autograph Hero lists upcoming autograph signings and meet &amp; greets. We collect as little as we can, we never sell your information, and you can delete your account yourself at any time.',
    sections: [
      ['What we collect and why', `<ul>
      <li><strong>When you sign up:</strong> your name, email address, a password, the teams, players and people you pick, and when you agreed to receive alerts. We use these to email you when your favorites have a signing and to let you log in and manage your account. Your password is stored only in scrambled (hashed) form by our login provider; nobody at Autograph Hero can see it.</li>
      <li><strong>When you log in:</strong> your login is remembered in your browser's storage on that device until you log out. If you forget your password, we email you a link to set a new one.</li>
      <li><strong>Reminders:</strong> if you ask for a reminder on a signing page, we keep your email and which signing it's for, send one reminder email (plus a confirmation with a cancel link), and delete the record 30 days after it's sent. Deleting your account removes your reminders too.</li>
      <li><strong>The app and offline pages:</strong> your browser keeps copies of the pages you open so they work without a signal, and remembers if you closed the "Get the app" banner. These stay on your device and are never sent to us. Clearing the site's data in your browser removes them.</li>
      <li><strong>When you submit a signing:</strong> the event details you enter, plus your name (optional) and email address so we can follow up. We check every submission before it goes on the calendar. Your name and email are never shown on the site.</li>
      <li><strong>When you contact us:</strong> your name (optional), email address, topic and message. We email it to ourselves so we can reply, and keep a copy to keep track of conversations. We don't add you to any mailing list.</li>
      <li><strong>To stop spam:</strong> a scrambled, one-way code made from your internet (IP) address, used to limit how many forms one visitor can send in an hour. The Submit a Signing form also uses a Cloudflare Turnstile check to tell people from bots.</li>
      <li><strong>Weekly alerts:</strong> once a week, if new signings were added for your favorites, we email you a short list with photos and links. Weeks with nothing new, you get nothing.</li>
      <li><strong>Site statistics:</strong> we use Cloudflare Web Analytics to count visits and popular pages. It does not use cookies and does not follow you to other websites.</li>
      <li><strong>Unique visitor count:</strong> to count how many different people visit each day, each page sends us your IP address and browser name, which we immediately scramble together with a random code that changes every day. We keep only the scrambled result, which can't be turned back into your IP address or linked from one day to the next. No cookies are used.</li>
    </ul>`],
      ['What we don\'t do', `<p>We don't sell or rent your information, we don't show ads, and we don't use advertising or tracking cookies. We only email you about signings for the favorites you chose, and about your account (such as login links).</p>`],
      ['Who helps us run the site', `<p>These services handle some information on our behalf, only to run Autograph Hero:</p>
    <ul>
      <li><strong>Supabase</strong>: stores sign-ups and submissions, and handles logins.</li>
      <li><strong>Resend</strong>: sends the welcome email, login links and alert emails.</li>
      <li><strong>Cloudflare</strong>: site statistics and the spam check.</li>
      <li><strong>Bluehost</strong>: hosts the website.</li>
      <li><strong>Google Fonts, Wikimedia Commons and promoter websites</strong>: the site's fonts and some photos load from these services, so they receive your IP address when your browser fetches them, as with any website.</li>
    </ul>`],
      ['Your choices', `<ul>
      <li>Change your favorites or turn alerts off on your <a href="${esc(link('/account/'))}">account page</a>.</li>
      <li>Delete your account there too. That removes your name, email and favorites.</li>
      <li>Every alert email includes a link to stop alerts.</li>
      <li>To ask what we hold about you, or anything else, ${contactLine()}.</li>
    </ul>`],
      ['How long we keep it', `<p>We keep your sign-up until you delete your account or ask us to. Submitted signings are kept as a record of the listings on the site. The scrambled spam-check codes are only used to count recent sends.</p>`],
      ['Children', `<p>Autograph Hero isn't meant for children under 13, and we don't knowingly collect their information. If you think a child has signed up, ${contactLine()} and we'll remove it.</p>`],
      ['Changes', `<p>If we change this policy, we'll update the date at the top of this page. If a change matters for how we use your email, we'll tell members by email before it takes effect.</p>`],
    ],
  });
}

function termsPage() {
  return policyPage({
    title: 'Terms of use',
    pathname: '/terms/',
    eyebrow: 'Terms',
    description: 'The terms for using Autograph Hero, including listings, submissions and accounts.',
    intro: 'By using Autograph Hero you agree to these terms. They are short, so please read them.',
    sections: [
      ['What Autograph Hero is', `<p>Autograph Hero is a free directory of upcoming autograph signings, meet &amp; greets and mail-in signings. Listings are gathered from public promoter and shop websites and from fans who submit them. We are not the organizer of any signing, we don't sell tickets or autographs, and we are not affiliated with the athletes, celebrities, teams, leagues or promoters listed unless we say so. Any purchase is between you and the organizer.</p>`],
      ['Listings can change', `<p>We work to keep listings accurate, but dates, times, prices, guests and availability can change or be cancelled without notice. Always confirm the details on the organizer's own page before you order, mail an item or travel. We aren't responsible for losses from relying on a listing.</p>`],
      ['Other websites', `<p>Listings link to the organizers' websites. We don't control those sites and aren't responsible for their content, products, prices or policies.</p>`],
      ['Submitting a signing', `<p>When you submit a signing, you confirm that the details are accurate to the best of your knowledge and that you're allowed to share them. You let us publish, edit and remove the listing details. We may decline any submission. We never publish your name or email.</p>`],
      ['Accounts and alerts', `<p>You can sign up for alert emails and log in with a link sent to your email. Keep access to your email account secure, since anyone who can read it can log in. You can change or delete your account at any time. We may close accounts or block form use that is abusive.</p>`],
      ['Fair use of the site', `<p>Please don't send spam or false listings, try to get around our spam checks, overload or attack the site, or copy the listings in bulk to republish elsewhere.</p>`],
      ['Names, logos and photos', `<p>Team, league and player names and logos belong to their owners and are used only to identify who is signing. Event photos belong to the promoters who published them. Some player photos come from Wikimedia Commons under their own licenses; see <a href="${esc(link('/photo-credits/'))}">photo credits</a>.</p>`],
      ['No guarantees', `<p>The site is provided as it is, without warranties of any kind. To the extent the law allows, Autograph Hero is not liable for any indirect or consequential losses arising from your use of the site or any listing.</p>`],
      ['Changes and contact', `<p>We may update these terms and will change the date at the top when we do. Questions? ${contactLine().replace(/^./, (c) => c.toUpperCase())}.</p>`],
    ],
  });
}

function creditsPage(list) {
  const seen = new Map();
  for (const s of list) {
    for (const p of [s.photo, s.photoFallback]) {
      if (p?.wikimedia && !seen.has(p.url)) seen.set(p.url, { ...p, name: p.of || s.name });
    }
  }
  const items = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  const body = `
<section class="page-head">
  <div class="eyebrow accent">Photo credits</div>
  <h1>Photo credits</h1>
  <p class="lede">Event photos come from the promoters' own listings and link back to them. When a promoter photo is missing or won't load, we show a freely licensed photo of the player from Wikimedia Commons. Those photographers are credited here.</p>
</section>
<section class="band band-tight">
  ${items.length ? `<ul class="credits">${items.map((p) => `<li><strong>${esc(p.name)}</strong>: ${p.page ? `<a href="${esc(p.page)}" rel="noopener">${esc(p.credit)}</a>` : esc(p.credit)}${p.license ? `, ${esc(p.license)}` : ''}</li>`).join('')}</ul>` : '<p class="muted">No Wikimedia Commons photos are in use right now.</p>'}
</section>`;
  return page({ title: 'Photo credits', description: 'Credits for the player photos used on Autograph Hero.', pathname: '/photo-credits/', body });
}

// Contact: a form that site-forms emails to the owner (CONTACT_TO, autographhero@gmail.com).
const CONTACT_TOPICS = ['General question', 'A signing is missing or wrong', 'Promoter or shop: list our signings', 'Account or email alerts', 'Something else'];
function contactPage() {
  const body = `
<section class="page-head">
  <div class="eyebrow accent">Contact</div>
  <h1>Get in touch</h1>
  <p class="lede">Questions, ideas, a signing we got wrong, or you run signings and want them listed? Send a message and we'll reply by email.</p>
</section>
<section class="band band-tight">
  <form class="f-form f-narrow" data-form="contact" data-endpoint="${esc(FORMS_URL)}" novalidate>
    <fieldset>
      <legend>Send us a message</legend>
      <div class="f-row">
        ${field('c-name', 'Your name', '<input id="c-name" name="name" type="text" maxlength="120" autocomplete="name">')}
        ${field('c-email', 'Email <span class="req">Required</span>', '<input id="c-email" name="email" type="email" required maxlength="254" autocomplete="email">', "So we can write back. We won't add you to any list.")}
      </div>
      ${field('c-topic', 'What is it about?', `<select id="c-topic" name="topic">${CONTACT_TOPICS.map((t) => `<option>${esc(t)}</option>`).join('')}</select>`)}
      ${field('c-message', 'Message <span class="req">Required</span>', '<textarea id="c-message" name="message" rows="6" required minlength="10" maxlength="4000"></textarea>')}
      ${honeypot}
      ${captchaBox()}
      <div class="f-actions"><button class="btn btn-accent" type="submit">Send message</button></div>
      ${formStatus}
    </fieldset>
    <p class="muted small">Know about a signing we don't have? The fastest way is <a href="${esc(link('/add/'))}">Submit A Signing</a>. You can also find us on <a href="${X_URL}" rel="noopener" target="_blank">X @autographheroX</a>.</p>
  </form>
</section>`;
  return page({
    title: 'Contact Autograph Hero',
    description: 'Questions, corrections or signings to list? Send Autograph Hero a message.',
    pathname: '/contact/',
    body,
    forms: true,
    captcha: Boolean(TURNSTILE_SITE_KEY),
    ld: [breadcrumbLd([['Home', '/'], ['Contact', '/contact/']]), { '@context': 'https://schema.org', '@type': 'ContactPage', name: 'Contact Autograph Hero', url: abs('/contact/') }],
  });
}

// About: the owner's story and what the site does.
function aboutPage() {
  const body = `
<section class="page-head about-head">
  <div class="eyebrow accent">About</div>
  <h1>Built by a collector, for collectors</h1>
  <p class="lede">Autograph Hero started with a simple love of autographs and sports cards, and a wish that finding the next signing were easier.</p>
</section>
<section class="band band-tight">
  <div class="prose">
    <h2>Why autographs</h2>
    <p>Autographs and sports cards have always been my passion. A signature turns a card, a ball or a jersey into something personal: a moment with a player you grew up watching, a piece of a championship season, a story you get to tell every time someone asks about it. Opening a pack and pulling a player you love is a thrill. Getting that same card signed is even better.</p>
    <p>Every collector knows the feeling: waiting in line at a show for your few seconds with an athlete you've cheered for, or opening the mail to find a piece back from a mail-in signing, signed and ready for the shelf.</p>
    <h2>Why I built this</h2>
    <p>The hard part was never the waiting in line. It was knowing the signing was happening at all. Signings are spread across dozens of promoter sites, card shop pages and social media posts. Order deadlines come and go quietly, and it's easy to hear about a signing for a player you collect only after it's too late.</p>
    <p>So I built Autograph Hero: one place to see upcoming autograph signings, meet &amp; greets and mail-in signings, with dates, prices and order deadlines side by side.</p>
    <h2>What you'll find here</h2>
    <ul>
      <li><strong>Every kind of signing.</strong> In-person signings at shows and card shops, private signings where you send your item in, and mail-in signings you can order from home.</li>
      <li><strong>Updated every week.</strong> Listings are gathered from promoter and shop websites, and fans <a href="${esc(link('/add/'))}">send in the ones we miss</a>. Every submission is checked before it goes live.</li>
      <li><strong>Alerts for your favorites.</strong> <a href="${esc(link('/signup/'))}">Sign up</a>, pick your teams, players and people, and get an email when they have a signing.</li>
      <li><strong>Player and team pages.</strong> Browse <a href="${esc(link('/autographs/'))}">signers A–Z</a> and <a href="${esc(link('/teams/'))}">teams</a>, or look back through the <a href="${esc(link('/archive/'))}">Signing Archives</a>.</li>
    </ul>
    <h2>A fan site, not a store</h2>
    <p>Autograph Hero doesn't sell tickets, take orders or handle anyone's items. Every listing links straight to the promoter or shop running the signing, and they handle the rest. Always check the details with them before you order or travel.</p>
    <h2>Say hello</h2>
    <p>If you collect too, I'd love to hear from you. <a href="${esc(link('/contact/'))}">Send me a message</a> or follow along on <a href="${X_URL}" rel="me noopener" target="_blank">X @autographheroX</a>. And if you know about a signing that isn't here yet, <a href="${esc(link('/add/'))}">send it in</a>.</p>
  </div>
</section>
<section class="band">
  <div class="cta-pair">
    <div class="cta cta-dark">
      <div class="eyebrow">Alerts</div>
      <h2>Never miss a signing</h2>
      <p>Tell us your favorite teams, players and people. We'll email you when one of them has a signing.</p>
      <a class="btn btn-accent" href="${esc(link('/signup/'))}">${ICON.bell}Sign Up</a>
    </div>
    <div class="cta">
      <div class="eyebrow">Coming up</div>
      <h2>See every upcoming signing</h2>
      <p>In person, private and mail-in signings, soonest first.</p>
      <a class="btn btn-ink" href="${esc(link('/events/'))}">${ICON.arrow}All Signings</a>
    </div>
  </div>
</section>`;
  return page({
    title: 'About Autograph Hero',
    description: 'Autograph Hero is built by a lifelong autograph and sports card collector to put every autograph signing, meet & greet and mail-in signing in one place.',
    pathname: '/about/',
    body,
    ld: [breadcrumbLd([['Home', '/'], ['About', '/about/']]), { '@context': 'https://schema.org', '@type': 'AboutPage', name: 'About Autograph Hero', url: abs('/about/') }],
  });
}

// "Signing Archives": signings that have happened, newest first, a section per month.
function archivePage(archive) {
  const months = new Map();
  for (const s of archive) {
    const key = s.sortDate.slice(0, 7);
    months.set(key, [...(months.get(key) || []), s]);
  }
  const monthName = (k) => fmt(`${k}-01`, { month: 'long', year: 'numeric' });
  const body = `
${crumbsNav([['Home', '/'], ['Signing Archives', '/archive/']])}
<section class="page-head">
  <div class="eyebrow accent">Past signings</div>
  <h1>Signing Archives</h1>
  <p class="lede">Autograph signings and meet &amp; greets we've listed that have already happened, newest first. Don't miss the next one: <a href="${esc(link('/signup/'))}">sign up for alerts</a> or <a href="${esc(link('/events/'))}">see what's coming up</a>.</p>
</section>
${archive.length ? [...months.entries()].map(([k, items]) => `<section class="band band-tight archive-month">
  <div class="section-head"><h2>${esc(monthName(k))}</h2><span class="muted">${items.length} signing${items.length === 1 ? '' : 's'}</span></div>
  <div class="grid">${items.map(card).join('\n')}</div>
</section>`).join('\n') : `<section class="band band-tight"><p class="empty">No past signings yet. Signings move here after their date.</p></section>`}`;
  return page({
    title: 'Signing Archives: Past Autograph Signings',
    description: `${archive.length} past autograph signings and meet & greets, newest first${archive[0] ? `, including ${[...new Set(archive.flatMap((s) => s.names))].slice(0, 3).join(', ')}` : ''}.`,
    pathname: '/archive/',
    body,
    ld: [breadcrumbLd([['Home', '/'], ['Signing Archives', '/archive/']])],
  });
}

// ---------- hub pages: one per signer, team and sport ----------
// People search "<name> autograph signing" or "<team> autograph signings", so each gets a page
// with its upcoming signings. Pages come from public.athletes as well as the signings, so a
// player's address stays the same between signings. With nothing coming up, a page still
// exists (old links keep working) but asks search engines not to list it until it has signings.

const signerPath = (slug) => `/autographs/${slug}/`;
const teamPath = (slug) => `/teams/${slug}/`;
const sportPath = (sport) => `/sports/${slugify(sport)}/`;

function buildHubs(list, athletes, archive = []) {
  const signers = new Map();
  const teams = new Map();
  const sports = new Map();
  const signer = (name, sport) => {
    const slug = slugify(name);
    if (!slug) return null;
    if (!signers.has(slug)) signers.set(slug, { slug, name: name.trim(), sport: null, list: [], past: [] });
    const h = signers.get(slug);
    if (!h.sport && sport) h.sport = sport;
    return h;
  };
  const team = (name) => {
    const slug = slugify(name);
    if (!slug) return null;
    if (!teams.has(slug)) teams.set(slug, { slug, name: name.trim(), sports: new Map(), list: [], past: [], signers: new Set() });
    return teams.get(slug);
  };
  const sport = (name) => {
    const slug = slugify(name);
    if (!slug) return null;
    if (!sports.has(slug)) sports.set(slug, { slug, name, list: [], signers: new Set(), teams: new Set() });
    return sports.get(slug);
  };

  for (const rows of athletes.values()) for (const a of rows) if (typeof a.name === 'string') signer(a.name, a.sport);
  for (const s of list) {
    for (const n of new Set(s.names)) signer(n, s.sport)?.list.push(s);
    for (const t of new Set(s.teams)) team(t)?.list.push(s);
    if (s.sport) sport(s.sport)?.list.push(s);
  }
  for (const s of archive) {
    for (const n of new Set(s.names)) signer(n, s.sport)?.past.push(s);
    for (const t of new Set(s.teams)) team(t)?.past.push(s);
  }
  for (const h of signers.values()) {
    const { teams: ts, primary } = teamsFor([h.name], h.sport, athletes);
    h.teams = ts.map((t) => team(t)).filter(Boolean);
    h.primary = (primary && team(primary)) || h.teams[0] || null;
    for (const t of h.teams) {
      t.signers.add(h);
      if (h.sport) t.sports.set(h.sport, (t.sports.get(h.sport) || 0) + 1);
    }
    h.photo = freePhotoFor([h.name], h.sport, athletes);
    if (h.sport) sport(h.sport)?.signers.add(h);
  }
  for (const t of teams.values()) {
    t.sport = [...t.sports.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    if (t.sport) sport(t.sport)?.teams.add(t);
  }
  return { signers, teams, sports };
}

const byName = (a, b) => a.name.localeCompare(b.name);
const plural = (n, word) => `${n} upcoming ${word}${n === 1 ? '' : 's'}`;

// Pill links to other hub pages, with a count of upcoming signings.
function chipList(items, pathFor) {
  return `<ul class="chips">${items.map((h) => `<li><a href="${esc(link(pathFor(h)))}">${esc(h.name)}${h.list.length ? `<span class="chip-n">${h.list.length}</span>` : ''}</a></li>`).join('')}</ul>`;
}

function breadcrumbLd(trail) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map(([name, p], i) => ({ '@type': 'ListItem', position: i + 1, name, ...(p ? { item: abs(p) } : {}) })),
  };
}

function crumbsNav(trail) {
  return `<nav class="crumbs" aria-label="Breadcrumb">${trail.map(([name, p], i) => (i < trail.length - 1 && p
    ? `<a href="${esc(link(p))}">${esc(name)}</a><span aria-hidden="true">/</span>`
    : `<span>${esc(name)}</span>`)).join('')}</nav>`;
}

function hubPage({ pathname, trail, eyebrow, h1, lede, photo: pic, favorite, alertText, list, past = [], sections = [], title, description }) {
  const cards = list.length
    ? `<div class="grid">${list.map(card).join('\n')}</div>`
    : `<div class="empty"><p><strong>Nothing is listed right now.</strong> Signings are added every week. Sign up and we'll email you when one is announced.</p></div>`;
  const body = `
${crumbsNav(trail)}
<section class="page-head hub-head">
  <div class="hub-copy">
    <div class="eyebrow accent">${esc(eyebrow)}</div>
    <h1>${esc(h1)}</h1>
    <p class="lede">${lede}</p>
    ${favorite ? `<p><a class="btn btn-ink" href="${esc(link(`/signup/?fav=${encodeURIComponent(favorite)}`))}">${ICON.bell}${esc(alertText || `Email me when ${favorite} signs`)}</a></p>` : ''}
  </div>
  ${pic ? `<figure class="hub-photo"><img src="${esc(pic.url)}" alt="${esc(pic.of || h1)}" referrerpolicy="no-referrer" onerror="this.parentNode.remove()"><figcaption class="credit">Photo: ${pic.page ? `<a href="${esc(pic.page)}" rel="noopener">${esc(pic.credit)}</a>` : esc(pic.credit)}${pic.license ? `, ${esc(pic.license)}` : ''}, via Wikimedia Commons</figcaption></figure>` : ''}
</section>
<section class="band band-tight hub-list">
  <div class="section-head"><h2>Upcoming signings</h2></div>
  ${cards}
</section>
${past.length ? `<section class="band">
  <div class="section-head"><h2>Past signings</h2><a class="more" href="${esc(link('/archive/'))}">Signing Archives ${ICON.arrow}</a></div>
  <div class="grid">${past.slice(0, 8).map(card).join('\n')}</div>
</section>` : ''}
${sections.filter((x) => x && x.items.length).map((x) => `<section class="band band-alt">
  <div class="section-head"><h2>${esc(x.title)}</h2></div>
  ${chipList(x.items, x.path)}
</section>`).join('\n')}`;
  return page({
    title,
    description,
    pathname,
    body,
    noindex: list.length ? false : 'follow',
    image: pic?.url || list.find((s) => s.photo)?.photo.url || null,
    imageAlt: h1,
    ld: [
      breadcrumbLd(trail),
      list.length ? {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: h1,
        itemListElement: list.map((s, i) => ({ '@type': 'ListItem', position: i + 1, url: abs(`/signing/${s.slug}/`), name: signingMeta(s).title })),
      } : null,
    ],
  });
}

const typeMix = (list) => {
  const n = (t) => list.filter((s) => s.type === t).length;
  return [n('public') && `${n('public')} in person`, n('mail-in') && `${n('mail-in')} by mail`, n('private') && `${n('private')} private`].filter(Boolean).join(', ');
};
const nextLine = (list) => {
  const first = list.find((s) => s.eventDate);
  return first ? ` The next one is ${longDate(first.eventDate)}${first.place && first.type === 'public' ? ` in ${first.place}` : ''}.` : '';
};

function signerPage(h) {
  const n = h.list.length;
  const teamText = h.teams.length ? `${h.name} has played for the ${joinNames(h.teams.map((t) => t.name))}.` : '';
  const lede = n
    ? `${esc(h.name)} has ${esc(plural(n, 'autograph signing'))} (${esc(typeMix(h.list))}).${esc(nextLine(h.list))} See dates, prices and order deadlines below.`
    : `There are no ${esc(h.name)} autograph signings listed right now.`;
  // Other signers from the team they're best known for, ones with signings coming up first.
  const related = [...(h.primary?.signers || [])].filter((o) => o !== h).sort((a, b) => (b.list.length > 0) - (a.list.length > 0) || byName(a, b)).slice(0, 30);
  return hubPage({
    pathname: signerPath(h.slug),
    trail: [['Home', '/'], ['Signers', '/autographs/'], [h.name, signerPath(h.slug)]],
    eyebrow: [h.sport, 'Autograph signings'].filter(Boolean).join(' · '),
    h1: `${h.name} autograph signings`,
    lede: lede + (teamText ? ` ${esc(teamText)}` : ''),
    photo: h.photo,
    favorite: h.name,
    list: h.list,
    past: h.past,
    sections: [
      { title: h.teams.length === 1 ? 'Team' : 'Teams', items: h.teams, path: (t) => teamPath(t.slug) },
      related.length ? { title: `More ${h.primary.name} signers`, items: related, path: (o) => signerPath(o.slug) } : null,
    ],
    title: `${h.name} Autograph Signings ${THIS_YEAR}${n ? ` (${n} upcoming)` : ''}`,
    description: n
      ? `${h.name} autograph signings and meet & greets: ${typeMix(h.list)}.${nextLine(h.list)} Prices, order deadlines and email alerts.`
      : `Get an email when ${h.name} has an autograph signing or meet & greet. Autograph Hero lists signings from promoters and shops every week.`,
  });
}

function teamPage(t) {
  const n = t.list.length;
  const people = [...t.signers].sort(byName);
  return hubPage({
    pathname: teamPath(t.slug),
    trail: [['Home', '/'], ['Teams', '/teams/'], [t.name, teamPath(t.slug)]],
    eyebrow: [t.sport, 'Team signings'].filter(Boolean).join(' · '),
    h1: `${t.name} autograph signings`,
    lede: n
      ? `${esc(plural(n, 'signing'))} with current and former ${esc(t.name)} players (${esc(typeMix(t.list))}).${esc(nextLine(t.list))}`
      : `No signings with ${esc(t.name)} players are listed right now.`,
    favorite: t.name,
    alertText: `Get ${t.name} signing alerts`,
    list: t.list,
    past: t.past,
    sections: [{ title: `${t.name} signers`, items: people, path: (o) => signerPath(o.slug) }],
    title: `${t.name} Autograph Signings ${THIS_YEAR}${n ? ` (${n} upcoming)` : ''}`,
    description: n
      ? `Upcoming autograph signings with current and former ${t.name} players: ${people.filter((p) => p.list.length).slice(0, 4).map((p) => p.name).join(', ')}. Dates, prices and order deadlines.`
      : `Get an email when a current or former ${t.name} player has an autograph signing.`,
  });
}

function sportPage(sp) {
  const n = sp.list.length;
  const people = [...sp.signers].filter((h) => h.list.length).sort(byName);
  const teams = [...sp.teams].filter((t) => t.list.length).sort(byName);
  return hubPage({
    pathname: sportPath(sp.name),
    trail: [['Home', '/'], ['All signings', '/events/'], [sp.name, sportPath(sp.name)]],
    eyebrow: 'Browse by sport',
    h1: `${sp.name} autograph signings`,
    lede: n ? `${esc(plural(n, sp.name.toLowerCase() + ' signing'))} (${esc(typeMix(sp.list))}), soonest first.` : `No ${esc(sp.name.toLowerCase())} signings are listed right now.`,
    list: sp.list,
    sections: [
      { title: 'Signers', items: people, path: (o) => signerPath(o.slug) },
      { title: 'Teams', items: teams, path: (t) => teamPath(t.slug) },
    ],
    title: `${sp.name} Autograph Signings ${THIS_YEAR}`,
    description: `${n} upcoming ${sp.name.toLowerCase()} autograph signings and meet & greets${people.length ? ` with ${people.slice(0, 3).map((p) => p.name).join(', ')} and more` : ''}. Dates, prices and order deadlines.`,
  });
}

// A–Z lists of every signer and team, grouped by sport, so every hub page is linked from somewhere.
function directoryPage({ pathname, eyebrow, h1, lede, items, path: pathFor, title, description }) {
  const groups = new Map();
  for (const h of [...items].sort(byName)) {
    const k = h.sport || 'Other';
    groups.set(k, [...(groups.get(k) || []), h]);
  }
  const order = [...groups.keys()].sort((a, b) => (a === 'Other') - (b === 'Other') || a.localeCompare(b));
  const body = `
${crumbsNav([['Home', '/'], [h1, pathname]])}
<section class="page-head">
  <div class="eyebrow accent">${esc(eyebrow)}</div>
  <h1>${esc(h1)}</h1>
  <p class="lede">${esc(lede)}</p>
</section>
${order.map((k) => `<section class="band band-tight dir-group">
  <h2 class="dir-h">${esc(k)}</h2>
  ${chipList(groups.get(k), pathFor)}
</section>`).join('\n')}`;
  return page({ title, description, pathname, body, ld: [breadcrumbLd([['Home', '/'], [h1, pathname]])] });
}

// ---------- build ----------

async function put(rel, content) {
  const file = path.join(OUT, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function main() {
  const [rows, athletes] = await Promise.all([loadSignings(), loadAthletes()]);
  const all = rows.map((row) => shape(row, athletes)).filter((s) => s.sortDate);
  const list = all.filter((s) => !s.past).sort((a, b) => a.sortDate.localeCompare(b.sortDate) || a.id - b.id);
  // Signing Archives: newest first.
  const archive = all.filter((s) => s.past).sort((a, b) => b.sortDate.localeCompare(a.sortDate) || b.id - a.id);

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await cp(path.join(ROOT, 'assets'), path.join(OUT, 'assets'), { recursive: true });

  await put('index.html', homePage(list));
  await put('events/index.html', eventsPage(list));
  for (const s of list) {
    const { html, ics } = signingPage(s, list);
    await put(`signing/${s.slug}/index.html`, html);
    if (ics) await put(`signing/${s.slug}/event.ics`, ics);
  }
  // Past signings keep their pages, so old links and search results still work.
  for (const s of archive) await put(`signing/${s.slug}/index.html`, signingPage(s, list).html);
  await put('archive/index.html', archivePage(archive));
  await put('about/index.html', aboutPage());
  await put('contact/index.html', contactPage());
  // Google Search Console ownership file (HTML file method). Keep it: removing it can lose Search Console access.
  await put('google9017fd775e03a772.html', 'google-site-verification: google9017fd775e03a772.html');
  await put('photo-credits/index.html', creditsPage([...list, ...archive]));
  const hubs = buildHubs(list, athletes, archive);
  for (const h of hubs.signers.values()) await put(`autographs/${h.slug}/index.html`, signerPage(h));
  for (const t of hubs.teams.values()) await put(`teams/${t.slug}/index.html`, teamPage(t));
  for (const sp of hubs.sports.values()) await put(`sports/${sp.slug}/index.html`, sportPage(sp));
  await put('autographs/index.html', directoryPage({
    pathname: '/autographs/',
    eyebrow: 'Signers A–Z',
    h1: 'Autograph signers',
    lede: 'Every athlete and celebrity we track. Numbers show upcoming signings; pick a name to see them or get an email when they sign.',
    items: [...hubs.signers.values()],
    path: (h) => signerPath(h.slug),
    title: 'Autograph Signers A–Z',
    description: `Upcoming autograph signings for ${hubs.signers.size} athletes and celebrities, from A to Z.`,
  }));
  await put('teams/index.html', directoryPage({
    pathname: '/teams/',
    eyebrow: 'Teams A–Z',
    h1: 'Signings by team',
    lede: 'Autograph signings with current and former players, grouped by team. Numbers show upcoming signings.',
    items: [...hubs.teams.values()],
    path: (t) => teamPath(t.slug),
    title: 'Autograph Signings by Team',
    description: `Autograph signings with current and former players from ${hubs.teams.size} pro teams.`,
  }));
  await put('add/index.html', addPage());
  await put('signup/index.html', signupPage(list, athletes));
  await put('account/index.html', accountPage(list, athletes));
  await put('privacy/index.html', privacyPage());
  await put('terms/index.html', termsPage());
  await put('admin/index.html', adminPage());
  await put('unsubscribe/index.html', unsubscribePage());
  await put('app/index.html', appPage());
  await put('reminder/index.html', reminderPage());
  await put('offline/index.html', offlinePage());
  await put('manifest.webmanifest', manifest());
  await put('sw.js', serviceWorker());
  await put('404.html', page({
    title: 'Page not found',
    description: 'That page is not here.',
    pathname: '/404',
    body: `<section class="page-head"><h1>That signing is over or moved</h1><p class="lede">Past signings come off the calendar. <a href="${esc(link('/events/'))}">See what is coming up.</a></p></section>`,
  }));
  // Search engines: a sitemap of every page, only once the site is meant to be indexed.
  // Only pages meant for search results: hub pages with nothing coming up are left out.
  const live = (m) => [...m.values()].filter((h) => h.list.length);
  const pages = [
    '/', '/events/', '/about/', '/contact/', '/archive/', '/autographs/', '/teams/', '/add/', '/signup/', '/app/', '/terms/', '/privacy/', '/photo-credits/',
    ...live(hubs.sports).map((sp) => sportPath(sp.name)),
    ...live(hubs.signers).map((h) => signerPath(h.slug)),
    ...live(hubs.teams).map((t) => teamPath(t.slug)),
    ...list.map((s) => `/signing/${s.slug}/`),
    ...archive.map((s) => `/signing/${s.slug}/`),
  ];
  await put('robots.txt', NOINDEX ? 'User-agent: *\nDisallow: /\n' : `User-agent: *\nDisallow: ${link('/admin/')}\nAllow: /\nSitemap: ${ORIGIN}${link('/sitemap.xml')}\n`);
  if (!NOINDEX) {
    await put('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map((p) => `  <url><loc>${esc(ORIGIN + link(p))}</loc><lastmod>${TODAY}</lastmod></url>`).join('\n')}\n</urlset>\n`);
  }
  // Once the site lives at the domain root, the old /new preview folder sends people to the same page at the root.
  if (!BASE) await put('new/.htaccess', 'RedirectMatch 301 ^/new/?(.*)$ /$1\n');
  // Apache (Bluehost): serve our index.html ahead of any WordPress index.php,
  // use our 404 page, and stop a parent WordPress .htaccess from rewriting our URLs.
  await put('.htaccess', [
    'DirectoryIndex index.html',
    `ErrorDocument 404 ${BASE}/404.html`,
    'RewriteEngine On',
    '',
    '# Addresses from the old WordPress site, so saved links and search results still work.',
    `RedirectMatch 301 ^${BASE}/terms-conditions/?$ ${BASE}/terms/`,
    `RedirectMatch 301 ^${BASE}/privacy-policy/?$ ${BASE}/privacy/`,
    `RedirectMatch 301 ^${BASE}/my-account(/.*)?$ ${BASE}/account/`,
    `RedirectMatch 301 ^${BASE}/submit-an-appearance/?$ ${BASE}/add/`,
    `RedirectMatch 301 ^${BASE}/(type|browse)(/.*)?$ ${BASE}/events/`,
    '',
    '# Pages change every hour, so the host\'s cache and browsers must check for a new copy',
    '# each time. Assets are fingerprinted (?v=...), so they can be kept. The app manifest and the',
    '# offline worker (sw.js) must also be re-checked, so installed apps pick up new versions.',
    'AddType application/manifest+json .webmanifest',
    '<IfModule mod_headers.c>',
    '  <FilesMatch "\\.(html|ics|txt|webmanifest)$">',
    '    Header set Cache-Control "no-cache, max-age=0, must-revalidate"',
    '    Header set X-Endurance-Cache-Level "0"',
    '  </FilesMatch>',
    '  <Files "sw.js">',
    '    Header set Cache-Control "no-cache, no-store, must-revalidate"',
    '    Header set X-Endurance-Cache-Level "0"',
    '  </Files>',
    '</IfModule>',
    '',
  ].join('\n'));

  console.log(`Built ${list.length} upcoming and ${archive.length} past signings (of ${rows.length} rows) into dist/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
