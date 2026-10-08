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

function shape(row) {
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
    listingUrl,
    host,
    source,
    image: safeUrl(row.image_url),
    imageSource: row.image_source || null,
    imageCredit: row.image_credit || null,
    imageLicense: row.image_license || null,
    imagePage: safeUrl(row.image_page_url),
  };
}

// ---------- components ----------

const ICON = {
  search: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
  arrow: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  out: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"/></svg>',
  cal: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4M12 13v5M9.5 15.5h5"/></svg>',
  pin: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
  logo: '<svg width="34" height="34" viewBox="0 0 36 36" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="18" cy="18" r="16"/><path d="M9 23c3-1 5-9 8-9s1 7 4 7 3-5 6-6" stroke-linecap="round"/></svg>',
};

const badge = (s) => `<span class="badge badge-${esc(s.type)}">${esc(TYPE_LABEL[s.type])}</span>`;

function photo(s, cls = '') {
  const img = s.image
    ? `<img src="${esc(s.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
    : '';
  return `<div class="photo ${cls}">${img}</div>`;
}

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
  const q = [s.name, s.title, s.venue, s.city, s.state, s.sport, s.teamCity, s.source].filter(Boolean).join(' ').toLowerCase();
  return `<a class="card" href="${esc(link(`/signing/${s.slug}/`))}" data-q="${esc(q)}" data-sport="${esc(s.sport || '')}" data-type="${esc(s.type)}" data-state="${esc(s.state || '')}">
  <div class="card-photo">${photo(s)}${badge(s)}</div>
  <div class="card-body">
    <div class="eyebrow">${esc([s.sport, s.teamCity].filter(Boolean).join(' · ') || 'Autographs')}</div>
    <h3>${esc(s.name)}</h3>
    <p class="where">${ICON.pin}<span>${esc(whereLine(s))}</span></p>
  </div>
  <div class="card-foot">
    <span class="mono">${esc(whenLine(s))}</span>
    <span class="price">${esc(priceLine(s))}</span>
  </div>
</a>`;
}

function page({ title, description, pathname, body, script = false }) {
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
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <a class="brand" href="${esc(link('/'))}">${ICON.logo}<span>AUTOGRAPH HERO</span></a>
  <nav aria-label="Main">
    <a href="${esc(link('/events/'))}"${pathname === '/events/' ? ' aria-current="page"' : ''}>All signings</a>
    <a href="${esc(link('/events/?type=public'))}">In person</a>
    <a href="${esc(link('/events/?type=mail-in'))}">Mail-in</a>
  </nav>
</header>
<main id="main">
${body}
</main>
<footer class="site-footer">
  <div class="brand">${ICON.logo}<span>AUTOGRAPH HERO</span></div>
  <p>Listings are gathered from promoter and shop websites and refreshed every week. Dates, prices and availability can change, so always confirm with the organizer before you order or travel.</p>
  <p class="mono small">Updated ${esc(longDate(TODAY))}</p>
</footer>
${script ? `<script src="${esc(link('/assets/site.js'))}" defer></script>` : ''}
</body>
</html>
`;
}

// ---------- pages ----------

function homePage(list) {
  const featured = list.find((s) => s.type === 'public' && s.image) || list.find((s) => s.image) || list[0];
  const sports = countBy(list, (s) => s.sport);
  const states = countBy(list, (s) => s.state);
  const soon = list.slice(0, 8);

  const feature = featured
    ? `<a class="feature" href="${esc(link(`/signing/${featured.slug}/`))}">
      <div class="feature-photo">${photo(featured)}<span class="badge badge-dark">Next up</span></div>
      <div class="tear"></div>
      <div class="feature-body">
        <div class="eyebrow accent">${esc([TYPE_LABEL[featured.type], featured.sport].filter(Boolean).join(' · '))}</div>
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
      <input id="h-q" name="q" type="search" placeholder="Athlete, team or city" autocomplete="off">
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
  ${soon.length ? `<div class="grid">${soon.map(card).join('\n')}</div>` : '<p class="empty">No upcoming signings are listed right now. Check back after the next weekly update.</p>'}
</section>

${sports.length ? `<section class="band band-alt">
  <div class="section-head"><h2>Browse by sport</h2></div>
  <div class="tiles">
    ${sports.map(([sp, n]) => `<a class="tile" href="${esc(link(`/events/?sport=${encodeURIComponent(sp)}`))}"><span class="tile-name">${esc(sp)}</span><span class="mono">${n} signing${n === 1 ? '' : 's'} ${ICON.arrow}</span></a>`).join('\n    ')}
  </div>
</section>` : ''}

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
      <input id="f-q" name="q" type="search" placeholder="Athlete, team or city" autocomplete="off">
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
  <div class="grid" id="results">${list.map(card).join('\n')}</div>
  <p class="empty" id="empty" hidden>No signings match those filters. Try clearing one.</p>
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
  const more = list.filter((o) => o.id !== s.id && ((s.sport && o.sport === s.sport) || (s.state && o.state === s.state))).slice(0, 3);
  const mapUrl = s.location && s.type !== 'mail-in' ? `https://www.google.com/maps/search/?${new URLSearchParams({ api: '1', query: s.location })}` : null;
  const credit = s.image && s.imageCredit
    ? `<p class="credit">Photo: ${s.imagePage && s.imageSource === 'wikimedia' ? `<a href="${esc(s.imagePage)}" rel="noopener">${esc(s.imageCredit)}</a>` : esc(s.imageCredit)}${s.imageLicense ? `, ${esc(s.imageLicense)}` : ''}</p>`
    : '';
  const rows = [
    s.eventDate ? ['Date', longDate(s.eventDate)] : s.eventDateText ? ['Date', s.eventDateText] : null,
    s.timeText ? ['Time', s.timeText] : null,
    s.deadline ? ['Order by', `${longDate(s.deadline)}${s.deadlinePassed ? ' (passed)' : ''}`] : null,
    s.venue ? ['Venue', s.venue] : null,
    s.place ? ['City', s.place] : null,
  ].filter(Boolean);

  const body = `
<nav class="crumbs" aria-label="Breadcrumb">
  <a href="${esc(link('/events/'))}">All signings</a><span aria-hidden="true">/</span>
  ${s.sport ? `<a href="${esc(link(`/events/?sport=${encodeURIComponent(s.sport)}`))}">${esc(s.sport)}</a><span aria-hidden="true">/</span>` : ''}
  <span>${esc(s.name)}</span>
</nav>
<section class="detail">
  <div class="detail-main">
    ${photo(s, 'photo-large')}
    ${credit}
    <h2>How this signing works</h2>
    <p class="lede">${esc(TYPE_BLURB[s.type])}</p>
    ${s.prices.length ? `<h2>Prices</h2>
    <div class="prices">${s.prices.map((p) => `<div><span>${esc(p.item)}</span><span class="mono">${esc(p.price)}</span></div>`).join('')}</div>` : ''}
    <p class="muted small">Listed from ${esc(s.source || 'the organizer')}. Autograph Hero does not sell tickets or handle orders.</p>
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
      <dl>${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
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
      <p class="muted small">Details can change. Confirm with the organizer before you order or travel.</p>
    </div>
  </aside>
</section>
${more.length ? `<section class="band band-alt">
  <div class="section-head"><h2>More like this</h2><a class="more" href="${esc(link('/events/'))}">See all signings ${ICON.arrow}</a></div>
  <div class="grid grid-3">${more.map(card).join('\n')}</div>
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

// ---------- build ----------

async function put(rel, content) {
  const file = path.join(OUT, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function main() {
  const rows = await loadSignings();
  const list = rows
    .map(shape)
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
