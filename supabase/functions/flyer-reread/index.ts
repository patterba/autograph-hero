// Reads an already-uploaded flyer again (e.g. when the first read failed) and fills the blanks
// on its submission. Same reader as site-forms (keep readFlyer in sync). POST {"id": N} with
// header x-cron-secret = Vault 'weekly_alerts_secret'. verify_jwt false.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const BASE_URL = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = (path: string, init: RequestInit = {}) =>
  fetch(`${BASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
const SPORTS = ["Football", "Baseball", "Basketball", "Hockey", "Soccer", "Wrestling", "MMA", "Golf", "Racing", "Entertainment", "Other"];
const text = (v: unknown, max: number) => {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
};
const isDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));
const url = (v: unknown) => {
  try {
    const u = new URL(String(v).trim());
    return (u.protocol === "https:" || u.protocol === "http:") && u.href.length <= 1000 ? u.href : null;
  } catch {
    return null;
  }
};
const today = () => new Date(Date.now() - 10 * 3600_000).toISOString().slice(0, 10); // a little slack for US time zones

const MULTI_TYPES = ["public", "private", "mail-in"];
const ANTHROPIC_MODEL = (Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5-5").trim();

async function anthropicKey() {
  const env = (Deno.env.get("ANTHROPIC_API_KEY") || "").trim();
  if (env) return env;
  const r = await db("rpc/site_anthropic_key", { method: "POST", body: "{}" });
  if (!r.ok) return null;
  const v = await r.json().catch(() => null);
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

const FLYER_PROMPT = `This image is a flyer, social media post or screenshot announcing an autograph signing, meet & greet, private signing or mail-in. Today is ${"{TODAY}"}.
Read it and reply with ONLY a JSON object, no other text:
{"athlete_names": [full names of the people signing], "signing_types": any of "public" (in person at a venue), "private" (private signing: send or drop off items, the person signs privately), "mail-in" (mail items in),
 "sport": one of ${JSON.stringify(SPORTS)} or null, "event_date": "YYYY-MM-DD" or null (first day if several; assume the next future date when no year is shown),
 "event_time_text": short time text like "1pm-3pm" or null, "order_deadline": "YYYY-MM-DD" or null, "venue": venue name and street address or null,
 "city": city or null, "state": 2-letter US state code or null, "price_text": the prices as one short line or null, "source_url": a full https:// URL printed on it or null,
 "summary": one sentence describing anything else important (ticket links, limits, inscriptions), or null}
Only include what the image actually says. If it isn't a signing announcement, reply {"athlete_names": []}.`;

async function readFlyer(id: number, b64: string, mime: string, given: Record<string, unknown>) {
  const mark = (fields: Record<string, unknown>) =>
    db(`submissions?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(fields), headers: { Prefer: "return=minimal" } });
  const key = await anthropicKey();
  if (!key) { await mark({ flyer_read: "off" }); return; }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL, max_tokens: 1200,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mime, data: b64 } },
        { type: "text", text: FLYER_PROMPT.replace("{TODAY}", today()) },
      ] }],
    }),
  });
  if (!res.ok) { console.error("anthropic", res.status, await res.text()); await mark({ flyer_read: "failed" }); return; }
  const out = await res.json();
  const raw = String(out?.content?.find((c: { type: string }) => c.type === "text")?.text || "");
  let x: Record<string, unknown> = {};
  try { x = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)); } catch { /* not JSON */ }
  const fill: Record<string, unknown> = { flyer_read: "ok" };
  // The fan's own answers win; the flyer only fills blanks.
  const blank = (k: string) => given[k] == null || (Array.isArray(given[k]) && !(given[k] as unknown[]).length);
  const names = (Array.isArray(x.athlete_names) ? x.athlete_names : []).map((n) => text(n, 80)).filter(Boolean).slice(0, 10);
  if (blank("athlete_names") && names.length) fill.athlete_names = names;
  const types = MULTI_TYPES.filter((t) => Array.isArray(x.signing_types) && x.signing_types.includes(t));
  if (blank("signing_types") && types.length) { fill.signing_types = types; fill.signing_type = types[0]; }
  if (blank("sport") && SPORTS.includes(String(x.sport))) fill.sport = String(x.sport);
  for (const k of ["event_date", "order_deadline"]) if (blank(k) && isDate(x[k])) fill[k] = String(x[k]);
  const lim: Record<string, number> = { event_time_text: 120, venue: 200, city: 100, state: 40, price_text: 1000 };
  for (const [k, n] of Object.entries(lim)) if (blank(k) && text(x[k], n)) fill[k] = text(x[k], n);
  if (blank("source_url") && url(x.source_url)) fill.source_url = url(x.source_url);
  const summary = text(x.summary, 600);
  if (summary) fill.notes = [given.notes, `From the flyer: ${summary}`].filter(Boolean).join("\n").slice(0, 2000);
  if (!names.length && blank("athlete_names")) fill.flyer_read = "failed";
  const r = await mark(fill);
  if (!r.ok) { console.error("flyer fill failed", r.status, await r.text()); await mark({ flyer_read: "failed" }); }
}


Deno.serve(async (req) => {
  const s = await db("rpc/site_cron_secret", { method: "POST", body: "{}" });
  const secret = s.ok ? await s.json() : null;
  if (!secret || req.headers.get("x-cron-secret") !== secret) return new Response("forbidden", { status: 403 });
  const { id } = await req.json().catch(() => ({}));
  const r = await db(`submissions?id=eq.${Number(id)}&select=*`);
  const [row] = r.ok ? await r.json() : [];
  if (!row?.flyer_path) return new Response("no flyer", { status: 404 });
  const img = await fetch(`${BASE_URL}/storage/v1/object/flyers/${row.flyer_path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!img.ok) return new Response("flyer missing", { status: 404 });
  const mime = img.headers.get("content-type") || "image/jpeg";
  const buf = new Uint8Array(await img.arrayBuffer());
  let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  await readFlyer(row.id, btoa(bin), mime, row);
  const after = await db(`submissions?id=eq.${row.id}&select=flyer_read`);
  return new Response(JSON.stringify((await after.json())[0] || {}), { headers: { "Content-Type": "application/json" } });
});
