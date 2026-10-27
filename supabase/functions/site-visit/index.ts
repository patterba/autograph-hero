// Counts unique visitors without cookies. Every page on autographhero.com sends one small
// request here (navigator.sendBeacon). The visitor's IP and browser name are scrambled with a
// salt that changes every day (public.site_record_visit), so nothing personal is stored.
// Deployed with verify_jwt false: anyone may call it; it only ever adds a scrambled code.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BOTS = /bot|crawl|spider|slurp|preview|monitor|headless|lighthouse|pingdom|curl|wget|python|httpclient|facebookexternalhit|embedly|whatsapp/i;
const SITE = /^https:\/\/(www\.)?autographhero\.com(\/|$)/;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: cors });
  const ua = req.headers.get('user-agent') || '';
  const from = req.headers.get('origin') || req.headers.get('referer') || '';
  // Only real browsers on the live site count.
  if (!ua || BOTS.test(ua) || !SITE.test(from)) return new Response(null, { status: 204, headers: cors });
  const ip = (req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  if (ip) {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/site_record_visit`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_ip: ip, p_ua: ua.slice(0, 300) }),
    }).catch(() => null);
  }
  return new Response(null, { status: 204, headers: cors });
});
