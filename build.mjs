// Autograph Hero site generator.
// Reads published signings from Supabase and writes a static site to ./dist.
// No dependencies: run with `node build.mjs` (Node 20+).

import { mkdir, writeFile, rm, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
// Cloudflare Turnstile site key (public) for the check on "Submit a signing".
// Set as the GitHub repository variable TURNSTILE_SITE_KEY; empty = no check shown.
const TURNSTILE_SITE_KEY = (process.env.TURNSTILE_SITE_KEY || '').trim();
const US_STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
const SPORT_CHOICES = ['Football', 'Baseball', 'Basketball', 'Hockey', 'Soccer', 'Wrestling', 'MMA', 'Golf', 'Racing', 'Entertainment', 'Other'];

const COLUMNS = [
  'id', 'title', 'athlete_names', 'signing_type', 'event_date', 'event_date_text',
  'event_time_text', 'order_deadline', 'venue', 'city', 'state', 'price_min', 'price_max',
  'prices', 'sport', 'team_city', 'listing_url', 'image_url', 'image_source',
  'image_credit', 'image_license', 'image_page_url',
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

// ---------- data ----------

async function loadSignings() {
  const qs = new URLSearchParams({
    select: COLUMNS.join(','),
    status: 'eq.published',
    order: 'event_date.asc.nullslast,id.asc',
    limit: '1000',
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
    venue: row.venue || null,
    city: row.city || null,
    state: row.state || null,
    place,
    location: [row.venue, row.city, row.state].filter(Boolean).join(', '),
    priceMin,
    priceMax,
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

const ICON = {
  search: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
  arrow: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  out: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"/></svg>',
  cal: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4M12 13v5M9.5 15.5h5"/></svg>',
  pin: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
  plus: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  bell: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>',
  logo: '<svg width="34" height="34" viewBox="0 0 36 36" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="18" cy="18" r="16"/><path d="M9 23c3-1 5-9 8-9s1 7 4 7 3-5 6-6" stroke-linecap="round"/></svg>',
};

const badge = (s) => `<span class="badge badge-${esc(s.type)}">${esc(TYPE_LABEL[s.type])}</span>`;

function photo(s, cls = '', id = '') {
  const img = s.photo
    ? `<img${id ? ` id="${id}"` : ''} src="${esc(s.photo.url)}"${s.photoFallback ? ` data-fallback="${esc(s.photoFallback.url)}"` : ''} alt="${esc(s.name)}" loading="lazy" referrerpolicy="no-referrer" onerror="ahPhoto(this)">`
    : '';
  return `<div class="photo ${cls}">${img}</div>`;
}

function creditLine(p, id, hidden = false) {
  if (!p) return '';
  const who = p.wikimedia && p.page ? `<a href="${esc(p.page)}" rel="noopener">${esc(p.credit)}</a>` : esc(p.credit || 'the organizer');
  return `<p class="credit" id="${id}"${hidden ? ' hidden' : ''}>Photo: ${who}${p.license ? `, ${esc(p.license)}` : ''}${p.wikimedia ? ', via Wikimedia Commons' : ''}</p>`;
}

// Runs when a photo fails to load: switch to the backup photo (and its credit), or hide it.
const PHOTO_SCRIPT = `<script>function ahPhoto(i){var f=i.getAttribute('data-fallback'),m=i.id==='main-photo',a=document.getElementById('credit-main'),b=document.getElementById('credit-fb');i.removeAttribute('data-fallback');if(f){i.onerror=function(){i.remove();if(m&&b)b.hidden=true};i.src=f;if(m){if(a)a.hidden=true;if(b)b.hidden=false}}else{i.remove();if(m&&a)a.hidden=true}}</script>`;

function whereLine(s) {
  if (s.type === 'mail-in') return `Mail-in${s.source ? ` · ${s.source}` : ''}`;
  if (s.venue && s.place) return `${s.venue.split(',')[0]}, ${s.place}`;
  return s.venue || s.place || (s.source ? `Via ${s.source}` : 'Location on organizer page');
}

function whenLine(s) {
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

function page({ title, description, pathname, body, script = false, forms = false, captcha = false }) {
  const full = title ? `${title} | ${SITE_NAME}` : `${SITE_NAME}: autograph signings and meet & greets`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(full)}</title>
<meta name="description" content="${esc(description)}">
${NOINDEX ? '<meta name="robots" content="noindex, nofollow">' : ''}
<meta property="og:title" content="${esc(full)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anton&family=IBM+Plex+Mono:wght@500;600&family=Instrument+Sans:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="${esc(link('/assets/site.css'))}">
${PHOTO_SCRIPT}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <a class="brand" href="${esc(link('/'))}">${ICON.logo}<span>AUTOGRAPH HERO</span></a>
  <nav aria-label="Main">
    <a href="${esc(link('/events/'))}"${pathname === '/events/' ? ' aria-current="page"' : ''}>All Signings</a>
    <a href="${esc(link('/events/?type=public'))}">In Person</a>
    <a href="${esc(link('/events/?type=mail-in'))}">Mail-In</a>
  </nav>
  <div class="header-actions">
    <a class="btn btn-accent btn-sm btn-pop" href="${esc(link('/add/'))}"${pathname === '/add/' ? ' aria-current="page"' : ''}>${ICON.plus}Submit A Signing</a>
    <a class="btn btn-ink btn-sm btn-stack" href="${esc(link('/signup/'))}"${pathname === '/signup/' ? ' aria-current="page"' : ''}><span class="btn-main">Sign Up</span><span class="btn-sub">Never Miss A Signing</span></a>
  </div>
</header>
<main id="main">
${body}
</main>
${pathname === '/add/' ? '' : `<div class="submit-bar" hidden>
  <span>Know a signing we're missing?</span>
  <a class="btn btn-accent btn-sm" href="${esc(link('/add/'))}">${ICON.plus}Submit A Signing</a>
</div>
<script>(function(){var bar=document.querySelector('.submit-bar'),top=document.querySelector('.header-actions');if(!bar||!top||!('IntersectionObserver' in window))return;new IntersectionObserver(function(e){bar.hidden=e[0].isIntersecting}).observe(top)})();</script>`}
<footer class="site-footer">
  <div class="brand">${ICON.logo}<span>AUTOGRAPH HERO</span></div>
  <p>Listings are gathered from promoter and shop websites and refreshed every week. Dates, prices and availability can change, so always confirm with the organizer before you order or travel.</p>
  <p class="small"><a href="${esc(link('/photo-credits/'))}">Photo credits</a></p>
  <p class="mono small">Updated ${esc(longDate(TODAY))}</p>
</footer>
${script ? `<script src="${esc(link('/assets/site.js'))}" defer></script>` : ''}
${forms ? `<script src="${esc(link('/assets/forms.js'))}" defer></script>` : ''}
${captcha ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ''}
</body>
</html>
`;
}

// ---------- pages ----------

function homePage(list) {
  const featured = list.find((s) => s.type === 'public' && s.photo) || list.find((s) => s.photo) || list[0];
  const sports = countBy(list, (s) => s.sport);
  const states = countBy(list, (s) => s.state);
  // 11 cards + the "See more" card = 12, which fills complete rows at 4, 3, 2 or 1 per row.
  const soon = list.slice(0, 11);

  const feature = featured
    ? `<a class="feature" href="${esc(link(`/signing/${featured.slug}/`))}">
      <div class="feature-photo">${photo(featured)}<span class="badge badge-dark">Next up</span></div>
      <div class="tear"></div>
      <div class="feature-body">
        <div class="eyebrow accent">${esc([TYPE_LABEL[featured.type], featured.primaryTeam || featured.sport].filter(Boolean).join(' · '))}</div>
        <div class="feature-name">${esc(featured.name)}</div>
        <div class="muted">${esc(whereLine(featured))}</div>
        <div class="feature-foot"><span class="mono">${esc(whenLine(featured))}${featured.timeText && featured.timeText.length < 24 ? ` · ${esc(featured.timeText)}` : ''}</span><span class="btn btn-accent">View signing</span></div>
      </div>
    </a>`
    : '';

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
    ${sports.map(([sp, n]) => `<a class="tile" href="${esc(link(`/events/?sport=${encodeURIComponent(sp)}`))}"><span class="tile-name">${esc(sp)}</span><span class="mono">${n} signing${n === 1 ? '' : 's'} ${ICON.arrow}</span></a>`).join('\n    ')}
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
    description: 'Find upcoming autograph signings and meet & greets with athletes and celebrities. Dates, prices and order deadlines in one place.',
    pathname: '/',
    body,
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
    title: 'Upcoming signings',
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
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n') + '\r\n';
  return { google: `https://calendar.google.com/calendar/render?${g}`, file, isDeadline };
}

function signingPage(s, list) {
  const cal = calendarFor(s);
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
    s.teams.length ? [s.teams.length === 1 ? 'Team' : 'Teams', s.teams.join(', '), 'wide'] : null,
  ].filter(Boolean);

  const body = `
<nav class="crumbs" aria-label="Breadcrumb">
  <a href="${esc(link('/events/'))}">All signings</a><span aria-hidden="true">/</span>
  ${s.sport ? `<a href="${esc(link(`/events/?sport=${encodeURIComponent(s.sport)}`))}">${esc(s.sport)}</a><span aria-hidden="true">/</span>` : ''}
  <span>${esc(s.name)}</span>
</nav>
<section class="detail">
  <div class="detail-main">
    ${photo(s, 'photo-large', 'main-photo')}
    ${credit}
    <h2>How this signing works</h2>
    <p class="lede">${esc(TYPE_BLURB[s.type])}</p>
    ${s.prices.length ? `<h2>Prices</h2>
    <div class="prices">${s.prices.map((p) => `<div><span>${esc(p.item)}</span><span class="mono">${esc(p.price)}</span></div>`).join('')}</div>` : ''}
    <p class="muted small">Listed from ${esc(s.source || 'the organizer')}. Autograph Hero does not sell tickets or handle orders.</p>
    <a class="inline-submit" href="${esc(link('/add/'))}">
      <span>${ICON.plus}</span>
      <span><strong>Know about another ${esc(s.names[0] || 'signing')}${s.names[0] ? ' signing' : ''}?</strong> Fans add signings we miss. Submit it and we'll put it on the calendar.</span>
    </a>
  </div>
  <aside class="ticket">
    <div class="ticket-top">
      <div class="badges">${badge(s)}${s.sport ? `<span class="badge badge-outline">${esc(s.sport)}</span>` : ''}</div>
      <h1>${esc(s.name)}</h1>
      <p class="muted">${esc(s.title)}</p>
    </div>
    <div class="tear"></div>
    <div class="ticket-body">
      ${s.deadlinePassed ? '<p class="notice">The order deadline listed for this signing has passed. Check with the organizer for late availability.</p>' : ''}
      <dl>${rows.map(([k, v, wide]) => `<div${wide ? ' class="wide"' : ''}><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
      ${s.priceMin ? `<div class="from"><span class="eyebrow">Price</span><span class="from-n">${esc(s.priceMax && s.priceMax !== s.priceMin ? `${s.priceMin} to ${s.priceMax}` : s.priceMin)}</span></div>` : ''}
      ${s.listingUrl ? `<a class="btn btn-accent btn-block" href="${esc(s.listingUrl)}" rel="noopener" target="_blank">${s.type === 'public' ? 'Get tickets' : 'Order'} at ${esc(s.host)} ${ICON.out}</a>` : ''}
      ${cal ? `<div class="cal">
        <span class="eyebrow">${cal.isDeadline ? 'Save the order deadline' : 'Add to calendar'}</span>
        <div class="cal-row">
          <a class="btn btn-ghost" href="${esc(cal.google)}" rel="noopener" target="_blank">${ICON.cal}Google</a>
          <a class="btn btn-ghost" href="${esc(link(`/signing/${s.slug}/event.ics`))}" download="${esc(s.slug)}.ics">${ICON.cal}Apple / Outlook</a>
        </div>
      </div>` : ''}
      ${mapUrl ? `<a class="maplink" href="${esc(mapUrl)}" rel="noopener" target="_blank">${ICON.pin}Open in Google Maps</a>` : ''}
      ${s.names.length ? `<a class="maplink" href="${esc(link(`/signup/?fav=${encodeURIComponent(s.names[0])}`))}">${ICON.bell}Email me when ${esc(s.names[0])} signs again</a>` : ''}
      <p class="muted small">Details can change. Confirm with the organizer before you order or travel.</p>
    </div>
  </aside>
</section>
${more.length ? `<section class="band band-alt">
  <div class="section-head"><h2>More like this</h2><a class="more" href="${esc(link('/events/'))}">See all signings ${ICON.arrow}</a></div>
  <div class="grid grid-related">${more.map(card).join('\n')}
${moreCard(list.length, null, s.sport)}</div>
</section>` : ''}`;

  const when = s.eventDate ? ` on ${longDate(s.eventDate)}` : '';
  const where = s.place && s.type === 'public' ? ` in ${s.place}` : '';
  return {
    html: page({
      title: `${s.name} autograph signing`,
      description: `${s.name} ${TYPE_LABEL[s.type].toLowerCase()} autograph signing${when}${where}. Prices, order deadline and how to take part.`,
      pathname: `/signing/${s.slug}/`,
      body,
    }),
    ics: cal ? cal.file : null,
  };
}

const field = (id, label, input, hint = '') =>
  `<div class="f-field"><label for="${id}">${label}</label>${input}${hint ? `<p class="f-hint" id="${id}-hint">${hint}</p>` : ''}</div>`;
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
    ${TURNSTILE_SITE_KEY ? `<div class="f-captcha"><p class="f-label" id="captcha-label">Quick check that you're a person <span class="req">Required</span></p><div class="cf-turnstile" data-sitekey="${esc(TURNSTILE_SITE_KEY)}" data-theme="light" data-size="flexible" aria-labelledby="captcha-label"></div></div>` : ''}
    <div class="f-actions"><button class="btn btn-accent" type="submit">Send for review</button></div>
    ${formStatus}
  </form>
</section>`;
  return page({ title: 'Submit a signing', description: 'Send us an autograph signing or meet & greet we are missing. Every listing is checked before it goes live.', pathname: '/add/', body, forms: true, captcha: Boolean(TURNSTILE_SITE_KEY) });
}

function signupPage(list, athletes) {
  // Suggestions for the favorites box: every team and every signer we know of.
  const options = new Set();
  for (const rows of athletes.values()) for (const a of rows) {
    if (a.name) options.add(a.name);
    for (const t of Array.isArray(a.teams) ? a.teams : []) if (t?.team) options.add(t.team);
  }
  for (const s of list) for (const n of s.names) options.add(n);
  const sorted = [...options].filter((o) => typeof o === 'string' && o.trim()).sort((a, b) => a.localeCompare(b));
  const body = `
<section class="page-head">
  <div class="eyebrow accent">Sign up</div>
  <h1>Never miss your favorites</h1>
  <p class="lede">Tell us who you follow. When one of your favorite teams, players or people has a signing, we'll send you an email.</p>
</section>
<section class="band band-tight">
  <form class="f-form f-narrow" data-form="signup" data-endpoint="${esc(FORMS_URL)}" novalidate>
    <fieldset>
      <legend><span class="f-n">01</span>Your details</legend>
      <div class="f-row">
        ${field('s-name', 'Name <span class="req">Required</span>', '<input id="s-name" name="name" type="text" required maxlength="120" autocomplete="name">')}
        ${field('s-email', 'Email <span class="req">Required</span>', '<input id="s-email" name="email" type="email" required maxlength="254" autocomplete="email">')}
      </div>
    </fieldset>
    <fieldset>
      <legend><span class="f-n">02</span>Your favorites</legend>
      <div class="f-field">
        <label for="s-fav">Add a team, player or person <span class="req">At least one</span></label>
        <div class="fav-entry">
          <input id="s-fav" type="text" list="fav-options" maxlength="80" autocomplete="off" placeholder="e.g. Denver Broncos or John Elway" aria-describedby="s-fav-hint">
          <button class="btn btn-ghost" type="button" data-fav-add>Add</button>
        </div>
        <p class="f-hint" id="s-fav-hint">Pick from the list or type your own, then press Add. You can add up to 25.</p>
        <datalist id="fav-options">${sorted.map((o) => `<option value="${esc(o)}"></option>`).join('')}</datalist>
        <ul class="fav-list" aria-label="Your favorites" data-fav-list></ul>
      </div>
    </fieldset>
    <label class="f-check"><input type="checkbox" name="consent" required> Email me when my favorites have a signing. I can unsubscribe at any time.</label>
    ${honeypot}
    <div class="f-actions"><button class="btn btn-accent" type="submit">${ICON.bell}Sign up for alerts</button></div>
    ${formStatus}
  </form>
</section>`;
  return page({ title: 'Sign up', description: 'Sign up to get an email when your favorite teams, players and people have an autograph signing.', pathname: '/signup/', body, forms: true });
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

// ---------- build ----------

async function put(rel, content) {
  const file = path.join(OUT, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function main() {
  const [rows, athletes] = await Promise.all([loadSignings(), loadAthletes()]);
  const list = rows
    .map((row) => shape(row, athletes))
    .filter((s) => s.sortDate && s.sortDate >= TODAY)
    .sort((a, b) => a.sortDate.localeCompare(b.sortDate) || a.id - b.id);

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
  await put('photo-credits/index.html', creditsPage(list));
  await put('add/index.html', addPage());
  await put('signup/index.html', signupPage(list, athletes));
  await put('404.html', page({
    title: 'Page not found',
    description: 'That page is not here.',
    pathname: '/404',
    body: `<section class="page-head"><h1>That signing is over or moved</h1><p class="lede">Past signings come off the calendar. <a href="${esc(link('/events/'))}">See what is coming up.</a></p></section>`,
  }));
  await put('robots.txt', NOINDEX ? 'User-agent: *\nDisallow: /\n' : 'User-agent: *\nAllow: /\n');
  // Apache (Bluehost): serve our index.html ahead of any WordPress index.php,
  // use our 404 page, and stop a parent WordPress .htaccess from rewriting our URLs.
  await put('.htaccess', [
    'DirectoryIndex index.html',
    `ErrorDocument 404 ${BASE}/404.html`,
    'RewriteEngine On',
    '',
  ].join('\n'));

  console.log(`Built ${list.length} upcoming signings (of ${rows.length} published rows) into dist/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
