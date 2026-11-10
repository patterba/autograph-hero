// Visitor numbers for the admin "Analytics" tab, from Cloudflare Web Analytics.
// Only admin logins (app_metadata.role = 'admin') get an answer. The Cloudflare API token
// (read-only "Account Analytics") is saved from the admin page into Vault and read here with
// the service role through public.site_cf_settings(). Deployed with verify_jwt false: it checks
// the caller's login itself.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const HOST = 'autographhero.com';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

async function isAdmin(req: Request): Promise<boolean> {
  const auth = req.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY, Authorization: auth } });
  if (!r.ok) return false;
  const u = await r.json().catch(() => null);
  return u?.app_metadata?.role === 'admin';
}

async function settings(): Promise<{ token: string | null; account: string | null }> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/site_cf_settings`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!r.ok) throw new Error(`settings ${r.status}`);
  return await r.json();
}

class CfError extends Error {}

async function cf(token: string, path: string, init: RequestInit = {}) {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const j = await r.json().catch(() => null);
  if (r.status === 401 || r.status === 403 || /authenticat/i.test(j?.errors?.[0]?.message || '')) throw new CfError('Cloudflare turned down the API token. Check that it has "Account Analytics: Read" and hasn\'t expired.');
  if (!r.ok) throw new CfError(`Cloudflare answered ${r.status}${j?.errors?.[0]?.message ? `: ${j.errors[0].message}` : ''}`);
  return j;
}

async function gql(token: string, query: string, variables: Record<string, unknown>) {
  const j = await cf(token, '/graphql', { method: 'POST', body: JSON.stringify({ query, variables }) });
  if (j?.errors?.length) throw new CfError(`Cloudflare: ${j.errors[0].message}`);
  return j.data;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const ZONE = 'America/Los_Angeles';
const laHour = (d: Date) => Number(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hour: 'numeric', hourCycle: 'h23' }).format(d));
const laDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
// Midnight Pacific at the start of a YYYY-MM-DD day, as a UTC time.
function laMidnight(d: string): Date {
  const guess = new Date(`${d}T08:00:00Z`);
  return new Date(guess.getTime() - laHour(guess) * 3600000);
}
// A filter written straight into the query (GraphQL input syntax: keys bare, strings quoted).
const lit = (v: unknown): string => Array.isArray(v) ? `[${v.map(lit).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.entries(v).map(([k, x]) => `${k}:${lit(x)}`).join(',')}}`
  : JSON.stringify(v);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply({ error: 'POST only' }, 405);
  try {
    if (!(await isAdmin(req))) return reply({ error: 'not an admin' }, 403);
    const body = await req.json().catch(() => ({}));
    const days = [7, 30].includes(Number(body?.days)) ? Number(body.days) : 30;
    // One day (Pacific), shown by hour: "date": "YYYY-MM-DD", today or up to 90 days back.
    const today = laDay(new Date());
    let date: string | null = null;
    if (typeof body?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
      const back = (Date.parse(today) - Date.parse(body.date)) / 86400000;
      if (back >= 0 && back <= 90) date = body.date;
    }
    // A start and end day (Pacific, inclusive): "from"/"to" as YYYY-MM-DD, within the last 90 days.
    let from: string | null = null, to: string | null = null;
    const ymd = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
    if (!date && ymd(body?.from)) {
      const min = laDay(new Date(Date.now() - 90 * 86400000));
      to = ymd(body?.to) || body.from;
      if (to! > today) to = today;
      from = body.from < min ? min : body.from;
      if (from! > to!) from = to;
      // Cloudflare answers at most about a month per query: keep the range to 31 days.
      const first = laDay(new Date(Date.parse(`${to}T12:00:00Z`) - 30 * 86400000));
      if (from! < first) from = first;
      if (from === to) { date = from; from = to = null; }
    }

    const { token, account: savedAccount } = await settings();
    if (!token) return reply({ connected: false });

    // The account: the one saved with the token, else the first one the token can see.
    let account = savedAccount;
    if (!account) {
      const list = await cf(token, '/accounts?per_page=5').catch(() => null);
      account = list?.result?.[0]?.id || null;
      if (!account) {
        // Tell a bad token apart from a good token that just can't list accounts.
        const ok = await cf(token, '/user/tokens/verify').then((j) => j?.result?.status === 'active').catch(() => false);
        throw new CfError(ok
          ? 'Cloudflare didn\'t say which account this token is for. Add your Account ID under "Change Cloudflare connection".'
          : 'Cloudflare turned down the API token. Check that you copied all of it and that it has "Account Analytics: Read".');
      }
    }

    let range: Record<string, string>;
    if (from && to) {
      const next = laMidnight(laDay(new Date(laMidnight(to).getTime() + 36 * 3600000)));
      const end = next.getTime() > Date.now() ? new Date() : new Date(next.getTime() - 1000);
      range = { datetime_geq: laMidnight(from).toISOString(), datetime_leq: end.toISOString() };
    } else if (date) {
      const from = laMidnight(date);
      const next = new Date(from.getTime() + 36 * 3600000);
      const to = laMidnight(laDay(next));
      const end = to.getTime() > Date.now() ? new Date() : new Date(to.getTime() - 1000);
      range = { datetime_geq: from.toISOString(), datetime_leq: end.toISOString() };
    } else {
      const end = new Date();
      const start = new Date(end.getTime() - (days - 1) * 86400000);
      range = { datetime_geq: `${day(start)}T00:00:00Z`, datetime_leq: end.toISOString() };
    }

    // Which Web Analytics site(s) are this domain (an account can have several sites).
    const sites = await gql(token, `query($a:String!){viewer{accounts(filter:{accountTag:$a}){
      rumPageloadEventsAdaptiveGroups(limit:50,filter:${lit(range)},orderBy:[count_DESC]){count dimensions{siteTag requestHost}}}}}`, { a: account });
    const groups = sites?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups || [];
    const tags = [...new Set(groups
      .filter((g: any) => String(g.dimensions?.requestHost || '').replace(/^www\./, '') === HOST)
      .map((g: any) => g.dimensions.siteTag))];
    if (!tags.length) return reply({ connected: true, days, date, from, to, empty: true });

    const f = lit({ AND: [range, { siteTag_in: tags }] });
    const top = (alias: string, dim: string, order = 'count_DESC', limit = 10) =>
      `${alias}: rumPageloadEventsAdaptiveGroups(limit:${limit},filter:${f},orderBy:[${order}]){count sum{visits} dimensions{metric:${dim}}}`;
    const data = await gql(token, `query($a:String!){viewer{accounts(filter:{accountTag:$a}){
      total: rumPageloadEventsAdaptiveGroups(limit:1,filter:${f}){count sum{visits}}
      byDay: rumPageloadEventsAdaptiveGroups(limit:100,filter:${f},orderBy:[date_ASC]){count sum{visits} dimensions{date}}
      ${date ? `byHour: rumPageloadEventsAdaptiveGroups(limit:30,filter:${f},orderBy:[datetimeHour_ASC]){count sum{visits} dimensions{datetimeHour}}` : ''}
      ${top('pages', 'requestPath', 'count_DESC', 15)}
      ${top('referrers', 'refererHost', 'sum_visits_DESC', 10)}
      ${top('countries', 'countryName', 'count_DESC', 10)}
      ${top('devices', 'deviceType', 'count_DESC', 5)}
      ${top('browsers', 'userAgentBrowser', 'count_DESC', 6)}
    }}}`, { a: account });
    const a = data?.viewer?.accounts?.[0] || {};
    const rows = (list: any[]) => (list || []).map((g) => ({ label: g.dimensions?.metric ?? '', views: g.count ?? 0, visits: g.sum?.visits ?? 0 }));
    // Cloudflare's hours are UTC; turn them into Pacific hours 0–23 of the chosen day.
    let byHour: { hour: number; views: number; visits: number }[] | undefined;
    if (date) {
      byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, views: 0, visits: 0 }));
      for (const g of a.byHour || []) {
        const t = new Date(g.dimensions?.datetimeHour);
        if (isNaN(t.getTime()) || laDay(t) !== date) continue;
        const slot = byHour[laHour(t)];
        slot.views += g.count ?? 0;
        slot.visits += g.sum?.visits ?? 0;
      }
    }
    return reply({
      connected: true,
      days: date ? 1 : days,
      date, from, to,
      byHour,
      totals: { views: a.total?.[0]?.count ?? 0, visits: a.total?.[0]?.sum?.visits ?? 0 },
      byDay: (a.byDay || []).map((g: any) => ({ date: g.dimensions?.date, views: g.count ?? 0, visits: g.sum?.visits ?? 0 })),
      pages: rows(a.pages),
      referrers: rows(a.referrers).filter((r) => r.label && r.label.replace(/^www\./, '') !== HOST),
      countries: rows(a.countries),
      devices: rows(a.devices),
      browsers: rows(a.browsers),
    });
  } catch (e) {
    if (e instanceof CfError) return reply({ connected: true, error: e.message });
    console.error(e);
    return reply({ error: 'Something went wrong loading visitor numbers.' }, 500);
  }
});
