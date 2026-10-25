// Receives the public forms on autographhero.com:
//   form = "listing": a fan submits a signing; saved to public.submissions as 'pending'
//                     for the owner to approve. Nothing goes live from here.
//   form = "signup":  a fan signs up for alerts about favorite teams and people;
//                     saved to public.subscribers (one row per email, updated on repeat).
//                     A new email also gets an email + password login (Supabase Auth),
//                     active right away (the page then logs them in). Welcome email via Resend.
//   form = "reset":   "forgot password": emails a link to set a new password, only to
//                     emails that signed up; the reply never says which.
//   form = "login":   (older) emails a one-time login link through Supabase Auth.
//   form = "delete_account": a logged-in member deletes their sign-up and their login.
// These are public forms. JWT verification is off on purpose (the site's anon key is
// public anyway); protection is validation, a hidden honeypot field, a minimum fill
// time, a per-visitor hourly limit and, for submitted signings and sign-ups, a
// Cloudflare Turnstile check once TURNSTILE_SECRET_KEY is set. Account deletion checks
// the member's own login token with Supabase Auth. Passwords are never stored or logged
// here; they go straight to Supabase Auth.
// The browser sends JSON as text/plain so no CORS preflight is needed.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const BASE_URL = Deno.env.get("SUPABASE_URL")!;
const DB = `${BASE_URL}/rest/v1`;
const AUTH = `${BASE_URL}/auth/v1`;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TURNSTILE_SECRET = (Deno.env.get("TURNSTILE_SECRET_KEY") || "").trim();
// Emails go through Resend. The key comes from the RESEND_API_KEY function secret or, if
// that isn't set, from Vault ('resend_api_key', read with the service role through
// public.site_resend_key()). No key = no email.
const RESEND_ENV = (Deno.env.get("RESEND_API_KEY") || "").trim();
let resendKey: string | null = RESEND_ENV || null;
const MAIL_FROM = (Deno.env.get("MAIL_FROM") || "Autograph Hero <alerts@autographhero.com>").trim();
const HOURLY_LIMIT = 5;
const LOGIN_HOURLY_LIMIT = 8;
const MIN_FILL_MS = 2500;
const MIN_LOGIN_MS = 800;
const SITE = "https://autographhero.com";
const SITE_PATHS = ["", "/new"]; // where the site may live; account links go to <path>/account/
const TYPES = ["public", "private", "mail-in", "unknown"];
const CAPTCHA_FAIL = "Please complete the quick check above the button, then try again.";
const SPORTS = ["Football", "Baseball", "Basketball", "Hockey", "Soccer", "Wrestling", "MMA", "Golf", "Racing", "Entertainment", "Other"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const fail = (message: string, status = 400) => reply(status, { ok: false, message });

const db = (path: string, init: RequestInit = {}) =>
  fetch(`${DB}/${path}`, {
    ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
const authAdmin = (path: string, body: unknown) =>
  fetch(`${AUTH}/admin/${path}`, {
    method: "POST",
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const text = (v: unknown, max: number) => {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
};
const isEmail = (v: string | null) => !!v && v.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
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
const sitePath = (b: Record<string, unknown>) => (SITE_PATHS.includes(String(b.path ?? "")) ? String(b.path ?? "") : "");
const html = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const clientIp = (req: Request) =>
  (req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "").split(",")[0].trim();

async function ipHash(req: Request) {
  const ip = clientIp(req) || "unknown";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`autographhero:${ip}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function overLimit(table: string, hash: string, limit = HOURLY_LIMIT) {
  const since = new Date(Date.now() - 3600_000).toISOString();
  const r = await db(`${table}?select=id&ip_hash=eq.${hash}&created_at=gte.${encodeURIComponent(since)}`, {
    headers: { Prefer: "count=exact", Range: "0-0" },
  });
  const total = Number((r.headers.get("content-range") || "*/0").split("/")[1]);
  return total >= limit;
}

// Cloudflare Turnstile. Off until the TURNSTILE_SECRET_KEY secret is set on this function.
async function captchaOk(token: unknown, req: Request) {
  if (!TURNSTILE_SECRET) return true;
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  const form = new URLSearchParams({ secret: TURNSTILE_SECRET, response: token });
  const ip = clientIp(req);
  if (ip) form.set("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const j = await r.json();
    if (j.success !== true) console.warn("turnstile rejected", JSON.stringify(j["error-codes"] || []));
    return j.success === true;
  } catch (err) {
    console.error("turnstile check failed", String(err));
    return false;
  }
}

// ---------- email ----------

async function getResendKey() {
  if (resendKey) return resendKey;
  try {
    const r = await db("rpc/site_resend_key", { method: "POST", body: "{}" });
    const k = r.ok ? await r.json() : null;
    resendKey = typeof k === "string" && k.trim() ? k.trim() : null;
  } catch (err) {
    console.error("reading the Resend key failed", String(err));
  }
  return resendKey;
}

async function sendMail(to: string, subject: string, htmlBody: string, textBody: string, label: string) {
  const key = await getResendKey();
  if (!key) { console.warn(`${label} email skipped: no Resend key (function secret or Vault)`); return false; }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html: htmlBody, text: textBody }),
    });
    if (!r.ok) { console.error(`${label} email failed`, r.status, await r.text()); return false; }
    console.log(`${label} email sent`);
    return true;
  } catch (err) {
    console.error(`${label} email failed`, String(err));
    return false;
  }
}

const wrap = (inner: string) =>
  `<div style="font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#16181D;max-width:560px">${inner}<p style="font-size:14px;color:#5B5A55">— Autograph Hero</p></div>`;
const button = (href: string, label: string) =>
  `<p><a href="${html(href)}" style="display:inline-block;background:#C2410C;color:#FFFFFF;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:999px">${html(label)}</a></p>`;

// ---------- logins ----------

async function hasLogin(email: string) {
  const r = await db("rpc/site_auth_user_exists", { method: "POST", body: JSON.stringify({ p_email: email }) });
  return r.ok ? (await r.json()) === true : false;
}

// A one-time token for a set-password ("recovery") link. The link goes to our own
// /account/ page, which exchanges the token with Supabase Auth.
async function oneTimeToken(type: "recovery", email: string) {
  const r = await authAdmin("generate_link", { type, email });
  const j = await r.json().catch(() => ({}));
  const t = j.hashed_token || j.properties?.hashed_token;
  if (!r.ok || !t) {
    console.error(`${type} link failed`, r.status, j.error_code || j.msg || j.message || "");
    return { token: null, error: String(j.error_code || j.msg || j.message || "") };
  }
  return { token: String(t), error: "" };
}
const accountLink = (path: string, token: string, type: string) =>
  `${SITE}${path}/account/?verify=${encodeURIComponent(token)}&type=${type}`;

// ---------- signings that match a fan's favorites (for the welcome email) ----------

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

type Match = { name: string; href: string; when: string; where: string; image: string | null; type: string };

// Upcoming published signings whose signer or one of the signer's teams matches a favorite,
// soonest first. "Broncos" matches "Denver Broncos"; "John Elway" matches John Elway.
async function matchingSignings(favorites: string[], path: string, max = 4): Promise<Match[]> {
  const favs = favorites.map((f) => f.toLowerCase().trim()).filter((f) => f.length >= 3);
  if (!favs.length) return [];
  // "Today" on the US West Coast, like the site.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
  const cols = "id,title,athlete_names,signing_type,event_date,order_deadline,venue,city,state,image_url";
  const [sr, ar] = await Promise.all([
    db(`signings?select=${cols}&status=eq.published&or=(event_date.gte.${today},and(event_date.is.null,order_deadline.gte.${today}))&limit=1000`),
    db("athletes?select=name,teams,image_url&status=eq.confirmed&limit=5000"),
  ]);
  if (!sr.ok) { console.error("matching signings failed", sr.status, await sr.text()); return []; }
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
  const hit = (term: string) => {
    const t = term.toLowerCase().trim();
    return t.length >= 3 && favs.some((f) => t.includes(f) || (t.length >= 4 && f.includes(t)));
  };
  const site = `${SITE}${path}`;
  const out: (Match & { sort: string; id: number })[] = [];
  for (const r of rows) {
    const names = (Array.isArray(r.athlete_names) ? r.athlete_names : []).filter((n: unknown) => typeof n === "string" && n.trim());
    const info = names.map((n: string) => byName.get(n.toLowerCase().trim()));
    const terms = [...names, ...info.flatMap((i: { teams: string[] } | undefined) => i?.teams || [])];
    if (!terms.some(hit)) continue;
    const name = joinNames(names) || r.title || "Autograph signing";
    const event = typeof r.event_date === "string" ? r.event_date : null;
    const deadline = typeof r.order_deadline === "string" ? r.order_deadline : null;
    const sort = event || deadline;
    if (!sort) continue;
    const typeLabel = r.signing_type === "mail-in" ? "Mail-in" : r.signing_type === "private" ? "Private signing" : r.signing_type === "public" ? "In person" : "Signing";
    out.push({
      id: r.id,
      sort,
      name,
      href: `${site}/signing/${r.id}-${slugify(name) || "signing"}/`,
      when: event ? fmtDay(event, { weekday: "short", month: "short", day: "numeric" }) : `Order by ${fmtDay(deadline!, { month: "short", day: "numeric" })}`,
      where: r.signing_type === "mail-in" ? "Mail-in" : [r.venue ? String(r.venue).split(",")[0] : "", [r.city, r.state].filter(Boolean).join(", ")].filter(Boolean).join(", "),
      image: httpsUrl(r.image_url) || info.map((i: { image: string | null } | undefined) => i?.image).find(Boolean) || null,
      type: typeLabel,
    });
  }
  out.sort((a, b) => a.sort.localeCompare(b.sort) || a.id - b.id);
  return out.slice(0, max);
}

// Email-safe (table) cards: photo on the left, name, date and place, all linking to the site.
function matchCards(matches: Match[]) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:8px 0 16px">
${matches.map((m) => `<tr><td style="padding:10px 0;border-top:1px solid #E5DED0">
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

// ---------- forms ----------

async function listing(b: Record<string, unknown>, hash: string, req: Request) {
  if (!(await captchaOk(b.captcha_token, req))) return fail(CAPTCHA_FAIL);
  const names = (Array.isArray(b.athlete_names) ? b.athlete_names : String(b.athlete_names ?? "").split(/,|&|\band\b/i))
    .map((n) => text(n, 80)).filter(Boolean).slice(0, 10) as string[];
  if (!names.length) return fail("Please enter who is signing.");
  const type = TYPES.includes(String(b.signing_type)) ? String(b.signing_type) : null;
  if (!type) return fail("Please choose how the signing works.");
  const event_date = isDate(b.event_date) ? String(b.event_date) : null;
  const order_deadline = isDate(b.order_deadline) ? String(b.order_deadline) : null;
  if (!event_date && !order_deadline) return fail("Please enter the signing date or the order deadline.");
  if ((event_date || order_deadline)! < today()) return fail("That date has already passed.");
  const source_url = url(b.source_url);
  if (!source_url) return fail("Please add a link to the official announcement or order page (starting with https://).");
  const submitter_email = text(b.submitter_email, 254)?.toLowerCase() || null;
  if (!isEmail(submitter_email)) return fail("Please enter a valid email address so we can follow up.");
  const sport = SPORTS.includes(String(b.sport)) ? String(b.sport) : null;

  const row = {
    athlete_names: names, signing_type: type, event_date, order_deadline,
    event_time_text: text(b.event_time_text, 120), venue: text(b.venue, 200), city: text(b.city, 100),
    state: text(b.state, 40), price_text: text(b.price_text, 1000), notes: text(b.notes, 2000),
    source_url, submitter_name: text(b.submitter_name, 120), submitter_email, sport, ip_hash: hash,
  };
  const r = await db("submissions", { method: "POST", body: JSON.stringify(row), headers: { Prefer: "return=minimal" } });
  if (!r.ok) {
    console.error("submission insert failed", r.status, await r.text());
    return fail("We couldn't save that just now. Please try again in a minute.", 500);
  }
  return reply(200, { ok: true, message: "Thanks! We'll check the details and add it to the calendar once it's confirmed." });
}

async function sendWelcome(name: string, email: string, favorites: string[], path: string, updated: boolean) {
  const site = `${SITE}${path}`;
  let matches: Match[] = [];
  try { matches = await matchingSignings(favorites, path); } catch (err) { console.error("matching signings failed", String(err)); }
  const first = name.split(" ")[0];
  const headline = updated ? "Your Autograph Hero alerts are updated." : "Thanks for signing up for Autograph Hero alerts!";
  const textBody = [
    `Hi ${first},`,
    "",
    headline,
    "",
    `We'll email you when any of your favorites has an autograph signing: ${favorites.join(", ")}.`,
    "",
    ...(matches.length
      ? ["Coming up for your favorites:", ...matches.map((m) => `- ${m.name}, ${m.when}${m.where ? `, ${m.where}` : ""}: ${m.href}`), ""]
      : []),
    `Log in any time with your email and password: ${site}/account/`,
    "",
    `See what's coming up now: ${site}/events/`,
    `Change your favorites or stop alerts any time: ${site}/account/`,
    "",
    "— Autograph Hero",
  ].join("\n");
  const body = wrap(`<p>Hi ${html(first)},</p>
<p><strong>${headline}</strong></p>
<p>We'll email you when any of your favorites has an autograph signing:</p>
<ul>${favorites.map((f) => `<li>${html(f)}</li>`).join("")}</ul>
${matches.length ? `<p style="font-size:18px;font-weight:700;margin:20px 0 4px">Coming up for your favorites</p>${matchCards(matches)}` : ""}
${button(`${site}/events/`, matches.length ? "See all upcoming signings" : "See upcoming signings")}
<p style="font-size:14px;color:#5B5A55">Log in any time at <a href="${site}/account/" style="color:#C2410C">autographhero.com/account</a> with your email and password. Forgot it? Use "Forgot password" on that page.</p>
<p style="font-size:14px;color:#5B5A55">Want to change your favorites or stop these emails? <a href="${site}/account/" style="color:#C2410C">Manage your alerts</a> any time.</p>`);
  await sendMail(email, updated ? "Your Autograph Hero alerts are updated" : "You're signed up for Autograph Hero alerts", body, textBody, updated ? "update" : "welcome");
}

async function signup(b: Record<string, unknown>, hash: string, req: Request) {
  if (!(await captchaOk(b.captcha_token, req))) return fail(CAPTCHA_FAIL);
  const name = text(b.name, 120);
  if (!name) return fail("Please enter your name.");
  const email = text(b.email, 254)?.toLowerCase() || null;
  if (!isEmail(email)) return fail("Please enter a valid email address.");
  const password = typeof b.password === "string" ? b.password : "";
  if (password.length < 8 || password.length > 72) return fail("Please choose a password of at least 8 characters.");
  if (b.consent !== true) return fail("Please tick the box to agree to receive alert emails.");
  const seen = new Set<string>();
  const favorites = (Array.isArray(b.favorites) ? b.favorites : [])
    .map((f) => text(f, 80)).filter((f): f is string => !!f && !seen.has(f.toLowerCase()) && !!seen.add(f.toLowerCase())).slice(0, 25);
  if (!favorites.length) return fail("Please add at least one favorite team, player or person.");

  const now = new Date().toISOString();
  const found = await db(`subscribers?select=id,favorites&email=eq.${encodeURIComponent(email!)}`);
  const existing = found.ok ? (await found.json())[0] : null;
  let r: Response;
  if (existing) {
    const merged = [...existing.favorites];
    for (const f of favorites) if (!merged.some((m: string) => m.toLowerCase() === f.toLowerCase())) merged.push(f);
    r = await db(`subscribers?id=eq.${existing.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name, favorites: merged.slice(0, 25), status: "active", consent_at: now, updated_at: now }),
      headers: { Prefer: "return=minimal" },
    });
  } else {
    r = await db("subscribers", {
      method: "POST",
      body: JSON.stringify({ name, email, favorites, consent_at: now, ip_hash: hash }),
      headers: { Prefer: "return=minimal" },
    });
  }
  if (!r.ok) {
    console.error("signup save failed", r.status, await r.text());
    return fail("We couldn't save that just now. Please try again in a minute.", 500);
  }

  // Login: a new email gets an email + password login that works right away. An existing
  // login keeps its password (never changed here; "Forgot password" resets it by email).
  const path = sitePath(b);
  const loginExists = await hasLogin(email!);
  let loginCreated = false;
  if (!loginExists) {
    const c = await authAdmin("users", { email, password, email_confirm: true });
    loginCreated = c.ok;
    if (!c.ok) console.error("creating login failed", c.status, await c.text());
  }
  const all = existing
    ? [...existing.favorites, ...favorites.filter((f) => !existing.favorites.some((m: string) => m.toLowerCase() === f.toLowerCase()))].slice(0, 25)
    : favorites;
  // Sent before replying (about a second) so it can't be cut off when the function shuts down.
  await sendWelcome(name, email!, all, path, !!existing);
  return reply(200, {
    ok: true,
    // The page logs the person in with the password they just chose when this is true.
    login: loginCreated || loginExists,
    message: loginExists
      ? "You already have an account, so we've added these favorites to it."
      : "You're signed up! We'll email you when your favorites have a signing.",
  });
}

const RESET_SENT = "If that email has signed up, we've sent a link to set a new password. Check your inbox (and spam folder) in a minute.";

async function reset(b: Record<string, unknown>, hash: string) {
  const email = text(b.email, 254)?.toLowerCase() || null;
  if (!isEmail(email)) return fail("Please enter a valid email address.");
  const path = sitePath(b);
  await db("login_requests", { method: "POST", body: JSON.stringify({ ip_hash: hash }), headers: { Prefer: "return=minimal" } });
  const found = await db(`subscribers?select=name&email=eq.${encodeURIComponent(email!)}&limit=1`);
  const member = found.ok ? (await found.json())[0] : null;
  if (!member) return reply(200, { ok: true, message: RESET_SENT });
  if (!(await hasLogin(email!))) {
    // Signed up before logins existed: create the login now; the link below sets its password.
    const c = await authAdmin("users", { email, password: crypto.randomUUID() + crypto.randomUUID(), email_confirm: true });
    if (!c.ok) console.error("creating login failed", c.status, await c.text());
  }
  const t = await oneTimeToken("recovery", email!);
  if (!t.token) return fail("We couldn't send the link just now. Please try again in a few minutes.", 500);
  const link = accountLink(path, t.token, "recovery");
  const first = String(member.name || "").split(" ")[0] || "there";
  await sendMail(email!, "Set your Autograph Hero password",
    wrap(`<p>Hi ${html(first)},</p>
<p>Click the button to set a new password for your Autograph Hero account. The link works once and expires in an hour.</p>
${button(link, "Set my password")}
<p style="font-size:14px;color:#5B5A55">Didn't ask for this? Ignore this email and your password stays the same.</p>`),
    [`Hi ${first},`, "", "Set a new password for your Autograph Hero account (the link works once and expires in an hour):", link, "", "Didn't ask for this? Ignore this email and your password stays the same.", "", "— Autograph Hero"].join("\n"),
    "reset");
  return reply(200, { ok: true, message: RESET_SENT });
}

const LOGIN_SENT = "If that email is signed up, a login link is on its way. Check your inbox (and spam folder) in a minute.";

async function login(b: Record<string, unknown>, hash: string) {
  const email = text(b.email, 254)?.toLowerCase() || null;
  if (!isEmail(email)) return fail("Please enter a valid email address.");
  const path = sitePath(b);
  await db("login_requests", { method: "POST", body: JSON.stringify({ ip_hash: hash }), headers: { Prefer: "return=minimal" } });

  const found = await db(`subscribers?select=id&email=eq.${encodeURIComponent(email!)}&limit=1`);
  const member = found.ok ? (await found.json())[0] : null;
  if (!member) return reply(200, { ok: true, message: LOGIN_SENT });

  const redirect = `${SITE}${path}/account/`;
  const r = await fetch(`${AUTH}/otp?redirect_to=${encodeURIComponent(redirect)}`, {
    method: "POST",
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, create_user: true }),
  });
  if (r.status === 429) return fail("A login link was sent a moment ago. Please wait a minute before asking for another.", 429);
  if (!r.ok) {
    console.error("login link failed", r.status, await r.text());
    return fail("We couldn't send a login link just now. Please try again in a few minutes.", 500);
  }
  return reply(200, { ok: true, message: LOGIN_SENT });
}

async function deleteAccount(b: Record<string, unknown>) {
  const token = typeof b.access_token === "string" && b.access_token.length < 4096 ? b.access_token : "";
  if (!token) return fail("Please log in again, then try once more.", 401);
  const who = await fetch(`${AUTH}/user`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
  if (!who.ok) return fail("Your login has expired. Please log in again, then try once more.", 401);
  const user = await who.json();
  const email = String(user.email || "").toLowerCase();
  if (!user.id || !email) return fail("Please log in again, then try once more.", 401);
  if (user.app_metadata?.role === "admin") return fail("This is the site's admin login, so it can't be deleted here.", 400);

  const r = await db(`subscribers?email=eq.${encodeURIComponent(email)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  if (!r.ok) {
    console.error("subscriber delete failed", r.status, await r.text());
    return fail("We couldn't delete your account just now. Please try again in a minute.", 500);
  }
  const a = await fetch(`${AUTH}/admin/users/${encodeURIComponent(user.id)}`, {
    method: "DELETE",
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  if (!a.ok) console.error("auth user delete failed", a.status, await a.text());
  return reply(200, { ok: true, message: "Your account and alert sign-up have been deleted." });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return fail("Not found", 404);
  let b: Record<string, unknown>;
  try {
    const raw = await req.text();
    if (raw.length > 20000) return fail("That's too much text.");
    b = JSON.parse(raw);
  } catch {
    return fail("Something went wrong sending the form. Please try again.");
  }

  if (b.form === "delete_account") return deleteAccount(b);

  // Bots: the hidden "website" field must stay empty and the form can't be sent instantly.
  const quick = b.form === "login" || b.form === "reset";
  if (b.website || Number(b.elapsed_ms) < (quick ? MIN_LOGIN_MS : MIN_FILL_MS)) {
    return reply(200, { ok: true, message: b.form === "login" ? LOGIN_SENT : b.form === "reset" ? RESET_SENT : "Thanks!" });
  }

  const hash = await ipHash(req);
  if (quick) {
    if (await overLimit("login_requests", hash, LOGIN_HOURLY_LIMIT)) return fail("Too many requests. Please try again later.", 429);
    return b.form === "reset" ? reset(b, hash) : login(b, hash);
  }
  const table = b.form === "listing" ? "submissions" : b.form === "signup" ? "subscribers" : null;
  if (!table) return fail("Unknown form.");
  if (await overLimit(table, hash)) return fail("You've sent a lot in the last hour. Please try again later.", 429);
  return table === "submissions" ? listing(b, hash, req) : signup(b, hash, req);
});
