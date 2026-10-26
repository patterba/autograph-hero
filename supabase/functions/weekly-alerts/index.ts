// Weekly alert email for fans who signed up on autographhero.com.
// For each active subscriber it finds upcoming published signings whose signer, or a team
// the signer played for, matches one of their favorites. If any of those went live since
// the fan's last weekly email (published_at), it sends one email: "New for your
// favorites" (photo + link to each signing page) and below it "Also coming up".
// Fans with nothing new get no email that week.
//
// Called by pg_cron once a week with the header x-cron-secret (Vault 'weekly_alerts_secret').
// For a test, POST {"only": "someone@example.com"} with the same header; add "force": true
// to send even when nothing is new, or "dry": true to only report what would be sent.
// JWT verification is off; the shared secret is the check.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const BASE_URL = Deno.env.get("SUPABASE_URL")!;
const DB = `${BASE_URL}/rest/v1`;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MAIL_FROM = (Deno.env.get("MAIL_FROM") || "Autograph Hero <alerts@autographhero.com>").trim();
const SITE = "https://autographhero.com";
const MAX_NEW = 8;
const MAX_UPCOMING = 4;

const db = (path: string, init: RequestInit = {}) =>
  fetch(`${DB}/${path}`, {
    ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const html = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

async function rpcText(name: string) {
  const r = await db(`rpc/${name}`, { method: "POST", body: "{}" });
  const v = r.ok ? await r.json() : null;
  return typeof v === "string" ? v.trim() : "";
}

// Same as build.mjs, so links point at the real signing pages.
const slugify = (v: string) => String(v).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
const joinNames = (n: string[]) => (n.length <= 1 ? n[0] || "" : n.length === 2 ? n.join(" & ") : `${n.slice(0, -1).join(", ")} & ${n.at(-1)}`);
const fmtDay = (iso: string, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts }).format(new Date(`${iso}T00:00:00Z`));
const httpsUrl = (v: unknown) => {
  try {
    const u = new URL(String(v));
    return u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
};

type Signing = {
  id: number; sort: string; publishedAt: string; name: string; href: string; when: string; where: string;
  image: string | null; type: string; terms: string[];
};

async function loadSignings(): Promise<Signing[]> {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
  const cols = "id,title,athlete_names,signing_type,event_date,order_deadline,venue,city,state,image_url,published_at,first_seen_at";
  const [sr, ar] = await Promise.all([
    db(`signings?select=${cols}&status=eq.published&or=(event_date.gte.${today},and(event_date.is.null,order_deadline.gte.${today}))&limit=2000`),
    db("athletes?select=name,teams,image_url&status=eq.confirmed&limit=5000"),
  ]);
  if (!sr.ok) throw new Error(`signings ${sr.status}: ${await sr.text()}`);
  const rows = await sr.json();
  const athletes = ar.ok ? await ar.json() : [];
  const byName = new Map<string, { teams: string[]; image: string | null }>();
  for (const a of athletes) {
    if (!a?.name) continue;
    const key = String(a.name).toLowerCase().trim();
    const prev = byName.get(key) || { teams: [], image: null };
    for (const t of Array.isArray(a.teams) ? a.teams : []) if (t && typeof t.team === "string") prev.teams.push(t.team);
    prev.image = prev.image || httpsUrl(a.image_url);
    byName.set(key, prev);
  }
  const out: Signing[] = [];
  for (const r of rows) {
    const names = (Array.isArray(r.athlete_names) ? r.athlete_names : []).filter((n: unknown) => typeof n === "string" && n.trim());
    const info = names.map((n: string) => byName.get(n.toLowerCase().trim()));
    const event = typeof r.event_date === "string" ? r.event_date : null;
    const deadline = typeof r.order_deadline === "string" ? r.order_deadline : null;
    const sort = event || deadline;
    if (!sort) continue;
    const name = joinNames(names) || r.title || "Autograph signing";
    out.push({
      id: r.id,
      sort,
      publishedAt: r.published_at || r.first_seen_at || "1970-01-01T00:00:00Z",
      name,
      href: `${SITE}/signing/${r.id}-${slugify(name) || "signing"}/`,
      when: event ? fmtDay(event, { weekday: "short", month: "short", day: "numeric" }) : `Order by ${fmtDay(deadline!, { month: "short", day: "numeric" })}`,
      where: r.signing_type === "mail-in" ? "Mail-in" : [r.venue ? String(r.venue).split(",")[0] : "", [r.city, r.state].filter(Boolean).join(", ")].filter(Boolean).join(", "),
      image: httpsUrl(r.image_url) || info.map((i: { image: string | null } | undefined) => i?.image).find(Boolean) || null,
      type: r.signing_type === "mail-in" ? "Mail-in" : r.signing_type === "private" ? "Private signing" : r.signing_type === "public" ? "In person" : "Signing",
      terms: [...names, ...info.flatMap((i: { teams: string[] } | undefined) => i?.teams || [])].map((t: string) => t.toLowerCase().trim()),
    });
  }
  out.sort((a, b) => a.sort.localeCompare(b.sort) || a.id - b.id);
  return out;
}

// "Broncos" matches "Denver Broncos"; "John Elway" matches John Elway.
function matchesFor(favorites: string[], all: Signing[]) {
  const favs = favorites.map((f) => String(f).toLowerCase().trim()).filter((f) => f.length >= 3);
  if (!favs.length) return [];
  const hit = (t: string) => t.length >= 3 && favs.some((f) => t.includes(f) || (t.length >= 4 && f.includes(t)));
  return all.filter((s) => s.terms.some(hit));
}

function cards(list: Signing[]) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:8px 0 16px">
${list.map((m) => `<tr><td style="padding:10px 0;border-top:1px solid #E5DED0">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
<td width="96" valign="top" style="padding-right:14px"><a href="${html(m.href)}">${m.image
    ? `<img src="${html(m.image)}" width="96" height="96" alt="${html(m.name)}" style="display:block;width:96px;height:96px;object-fit:cover;border-radius:10px;border:1px solid #16181D">`
    : `<div style="width:96px;height:96px;border-radius:10px;border:1px solid #16181D;background:#E9E1D2"></div>`}</a></td>
<td valign="top" style="font-family:Helvetica,Arial,sans-serif">
<div style="font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#C2410C">${html(m.type)}</div>
<div style="font-size:18px;font-weight:700;line-height:1.25;margin:2px 0"><a href="${html(m.href)}" style="color:#16181D;text-decoration:none">${html(m.name)}</a></div>
<div style="font-size:14px;color:#3A3935">${html(m.when)}${m.where ? ` · ${html(m.where)}` : ""}</div>
<div style="font-size:14px;margin-top:4px"><a href="${html(m.href)}" style="color:#C2410C;font-weight:600">See the signing →</a></div>
</td></tr></table></td></tr>`).join("\n")}
</table>`;
}

function digest(sub: { name: string; unsubscribe_token: string }, fresh: Signing[], upcoming: Signing[]) {
  const first = String(sub.name || "").split(" ")[0] || "there";
  const unsub = `${SITE}/unsubscribe/?t=${encodeURIComponent(sub.unsubscribe_token)}`;
  const names = [...new Set(fresh.map((s) => s.name))];
  const subject = names.length === 1
    ? `New signing: ${names[0]}`
    : `${fresh.length} new signings for your favorites`;
  const body = `<div style="font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#16181D;max-width:560px">
<p>Hi ${html(first)},</p>
<p>${fresh.length === 1 ? "A new signing was" : `${fresh.length} new signings were`} added this week for your favorites.</p>
<p style="font-size:20px;font-weight:700;margin:20px 0 4px">New this week</p>
${cards(fresh)}
${upcoming.length ? `<p style="font-size:18px;font-weight:700;margin:24px 0 4px">Also coming up</p>${cards(upcoming)}` : ""}
<p><a href="${SITE}/events/" style="display:inline-block;background:#C2410C;color:#FFFFFF;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:999px">See all upcoming signings</a></p>
<p style="font-size:13px;color:#5B5A55;margin-top:24px">You're getting this because you signed up for alerts on Autograph Hero.
<a href="${SITE}/account/" style="color:#C2410C">Change your favorites</a> or <a href="${html(unsub)}" style="color:#C2410C">stop these emails</a>.</p>
</div>`;
  const text = [
    `Hi ${first},`,
    "",
    `New this week for your favorites:`,
    ...fresh.map((s) => `- ${s.name}, ${s.when}${s.where ? `, ${s.where}` : ""}: ${s.href}`),
    ...(upcoming.length ? ["", "Also coming up:", ...upcoming.map((s) => `- ${s.name}, ${s.when}${s.where ? `, ${s.where}` : ""}: ${s.href}`)] : []),
    "",
    `All upcoming signings: ${SITE}/events/`,
    `Change your favorites: ${SITE}/account/`,
    `Stop these emails: ${unsub}`,
  ].join("\n");
  return { subject, html: body, text, unsub };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(404, { ok: false });
  const secret = await rpcText("site_cron_secret");
  if (!secret || req.headers.get("x-cron-secret") !== secret) return json(401, { ok: false });
  const opts = await req.json().catch(() => ({})) as { only?: string; force?: boolean; dry?: boolean };
  const resendKey = (Deno.env.get("RESEND_API_KEY") || "").trim() || (await rpcText("site_resend_key"));
  if (!resendKey) return json(500, { ok: false, error: "no Resend key" });

  const all = await loadSignings();
  let q = "subscribers?select=id,name,email,favorites,unsubscribe_token,last_digest_at,created_at&status=eq.active&limit=10000";
  if (opts.only) q += `&email=eq.${encodeURIComponent(String(opts.only).toLowerCase())}`;
  const sr = await db(q);
  if (!sr.ok) return json(500, { ok: false, error: await sr.text() });
  const subs = await sr.json();

  const weekAgo = Date.now() - 8 * 24 * 3600_000;
  const outgoing: { id: number; email: string; payload: Record<string, unknown> }[] = [];
  const report: { email: string; fresh: number; upcoming: number; sent: boolean }[] = [];
  for (const s of subs) {
    const matches = matchesFor(Array.isArray(s.favorites) ? s.favorites : [], all);
    // New = went live since this fan's last weekly email (or sign-up), looking back at most 8 days.
    const since = Math.max(Date.parse(s.last_digest_at || s.created_at || 0) || 0, weekAgo);
    let fresh = matches.filter((m) => Date.parse(m.publishedAt) > since);
    if (!fresh.length && opts.force) fresh = matches.slice(0, 2);
    if (!fresh.length) { report.push({ email: s.email, fresh: 0, upcoming: matches.length, sent: false }); continue; }
    fresh = fresh.slice(0, MAX_NEW);
    const freshIds = new Set(fresh.map((f) => f.id));
    const upcoming = matches.filter((m) => !freshIds.has(m.id)).slice(0, MAX_UPCOMING);
    const d = digest(s, fresh, upcoming);
    outgoing.push({
      id: s.id,
      email: s.email,
      payload: {
        from: MAIL_FROM, to: [s.email], subject: d.subject, html: d.html, text: d.text,
        headers: { "List-Unsubscribe": `<${d.unsub}>` },
      },
    });
    report.push({ email: s.email, fresh: fresh.length, upcoming: upcoming.length, sent: !opts.dry });
  }

  if (!opts.dry) {
    // Resend's batch endpoint takes up to 100 emails per call.
    for (let i = 0; i < outgoing.length; i += 100) {
      const chunk = outgoing.slice(i, i + 100);
      const r = await fetch("https://api.resend.com/emails/batch", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(chunk.map((c) => c.payload)),
      });
      if (!r.ok) {
        console.error("weekly batch failed", r.status, await r.text());
        for (const c of chunk) { const row = report.find((x) => x.email === c.email); if (row) row.sent = false; }
        continue;
      }
      const ids = chunk.map((c) => c.id).join(",");
      await db(`subscribers?id=in.(${ids})`, {
        method: "PATCH",
        body: JSON.stringify({ last_digest_at: new Date().toISOString() }),
        headers: { Prefer: "return=minimal" },
      });
      await new Promise((ok) => setTimeout(ok, 600)); // stay under Resend's rate limit
    }
  }
  const sent = report.filter((r) => r.sent).length;
  console.log(`weekly alerts: ${sent} sent, ${report.length - sent} skipped`);
  return json(200, { ok: true, sent, checked: report.length, report: opts.only || opts.dry ? report : undefined });
});
