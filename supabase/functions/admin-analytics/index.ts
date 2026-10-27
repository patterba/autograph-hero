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
// A filter written straight into the query (GraphQL input syntax: keys bare, strings quoted).
const lit = (v: unknown): string => Array.isArray(v) ? `[${v.map(lit).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.entries(v).map(([k, x]) => `${k}:${lit(x)}`).join(',')}}`
  : JSON.stringify(v);

// Unique visitors come from the domain's own traffic numbers (Cloudflare counts them once a day
// per visitor). That needs the token to also have "Zone → Analytics → Read"; without it the tab
// shows how to add it. Never fails the rest of the tab.
async function uniqueVisitors(token: string, start: Date, end: Date) {
  try {
    const z = await cf(token, `/zones?name=${HOST}`).catch(() => null);
    const zone = z?.result?.[0]?.id;
    if (!zone) return { missing: 'permission' };
    const d = await gql(token, `query($z:String!){viewer{zones(filter:{zoneTag:$z}){
      httpRequests1dGroups(limit:40,filter:${lit({ date_geq: day(start), date_leq: day(end) })},orderBy:[date_ASC]){dimensions{date} uniq{uniques}}}}}`, { z: zone });
    const days = d?.viewer?.zones?.[0]?.httpRequests1dGroups || [];
    return {
      total: days.reduce((n: number, g: any) => n + (g.uniq?.uniques ?? 0), 0),
      byDay: days.map((g: any) => ({ date: g.dimensions?.date, uniques: g.uniq?.uniques ?? 0 })),
    };
  } catch (e) {
    if (e instanceof CfError && /turned down|not authorized|permission|access|authenticat/i.test(e.message)) return { missing: 'permission' };
    return { error: e instanceof Error ? e.message : 'unavailable' };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply({ error: 'POST only' }, 405);
  try {
    if (!(await isAdmin(req))) return reply({ error: 'not an admin' }, 403);
    const body = await req.json().catch(() => ({}));
    const days = [7, 30].includes(Number(body?.days)) ? Number(body.days) : 30;

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

    const end = new Date();
    const start = new Date(end.getTime() - (days - 1) * 86400000);
    const range = { datetime_geq: `${day(start)}T00:00:00Z`, datetime_leq: end.toISOString() };

    // Which Web Analytics site(s) are this domain (an account can have several sites).
    const sites = await gql(token, `query($a:String!){viewer{accounts(filter:{accountTag:$a}){
      rumPageloadEventsAdaptiveGroups(limit:50,filter:${lit(range)},orderBy:[count_DESC]){count dimensions{siteTag requestHost}}}}}`, { a: account });
    const groups = sites?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups || [];
    const tags = [...new Set(groups
      .filter((g: any) => String(g.dimensions?.requestHost || '').replace(/^www\./, '') === HOST)
      .map((g: any) => g.dimensions.siteTag))];
    if (!tags.length) return reply({ connected: true, days, empty: true });

    const f = lit({ AND: [range, { siteTag_in: tags }] });
    const top = (alias: string, dim: string, order = 'count_DESC', limit = 10) =>
      `${alias}: rumPageloadEventsAdaptiveGroups(limit:${limit},filter:${f},orderBy:[${order}]){count sum{visits} dimensions{metric:${dim}}}`;
    const data = await gql(token, `query($a:String!){viewer{accounts(filter:{accountTag:$a}){
      total: rumPageloadEventsAdaptiveGroups(limit:1,filter:${f}){count sum{visits}}
      byDay: rumPageloadEventsAdaptiveGroups(limit:100,filter:${f},orderBy:[date_ASC]){count sum{visits} dimensions{date}}
      ${top('pages', 'requestPath', 'count_DESC', 15)}
      ${top('referrers', 'refererHost', 'sum_visits_DESC', 10)}
      ${top('countries', 'countryName', 'count_DESC', 10)}
      ${top('devices', 'deviceType', 'count_DESC', 5)}
      ${top('browsers', 'userAgentBrowser', 'count_DESC', 6)}
    }}}`, { a: account });
    const a = data?.viewer?.accounts?.[0] || {};
    const uniques = await uniqueVisitors(token, start, end);
    const rows = (list: any[]) => (list || []).map((g) => ({ label: g.dimensions?.metric ?? '', views: g.count ?? 0, visits: g.sum?.visits ?? 0 }));
    return reply({
      connected: true,
      days,
      totals: { views: a.total?.[0]?.count ?? 0, visits: a.total?.[0]?.sum?.visits ?? 0 },
      uniques,
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
