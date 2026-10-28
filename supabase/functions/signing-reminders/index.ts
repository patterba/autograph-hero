// "Email me a reminder" on signing pages: saves the request and sends one email before the signing.
//
// Two callers:
//   1. The signing page (assets/remind.js) posts {form: "remind", signing_id, email | access_token}
//      or, from the cancel link, {form: "cancel_reminder", token}. Public, like site-forms: JSON
//      sent as text/plain (no CORS preflight), honeypot, minimum time on the page, hourly limit per
//      visitor, Turnstile for logged-out visitors once TURNSTILE_SECRET_KEY is set. Logged-in members
//      send their login token instead of an email. Saved to public.reminders (private), with a
//      confirmation email carrying a cancel link (/reminder/?cancel=<token>).
//   2. pg_cron, hourly, with the header x-cron-secret (see below), which sends what's due.
//
// When reminders go out:
//   kind 'event':    about 24 hours before the signing starts (9 AM the day before when the
//                    listing has no readable start time).
//   kind 'deadline': mail-in and private signings, 9 AM Pacific the day before the order
//                    deadline, while there's still time to order.
// The hourly run (Vault 'weekly_alerts_secret', the same secret as weekly-alerts) sends every
// pending reminder that's due, marks it 'sent', marks ones whose moment has passed 'missed', and
// deletes rows 30 days later. Deleting an account removes that email's reminders (a trigger on
// public.subscribers).
// Test: POST {"dry": true} with the secret reports what would go out; {"only": "someone@example.com",
// "force": true} sends that address's pending reminders now, whatever the time.
// JWT verification is off; the form checks above and the shared secret are the protection.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const BASE_URL = Deno.env.get("SUPABASE_URL")!;
const DB = `${BASE_URL}/rest/v1`;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AUTH = `${BASE_URL}/auth/v1`;
const MAIL_FROM = (Deno.env.get("MAIL_FROM") || "Autograph Hero <alerts@autographhero.com>").trim();
const TURNSTILE_SECRET = (Deno.env.get("TURNSTILE_SECRET_KEY") || "").trim();
const SITE = "https://autographhero.com";
const SITE_PATHS = ["", "/new"]; // where the site may live
const REMIND_HOURLY_LIMIT = 12;
const MIN_FILL_MS = 1500;
const SITE_TZ = "America/Los_Angeles";
const HOUR = 3600_000;

const db = (path: string, init: RequestInit = {}) =>
  fetch(`${DB}/${path}`, {
    ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const fail = (message: string, status = 400) => json(status, { ok: false, message });
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
const httpsUrl = (v: unknown) => {
  try {
    const u = new URL(String(v));
    return u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
};

// ---------- timing ----------

type Row = {
  id: number; title: string | null; athlete_names: string[] | null; signing_type: string | null;
  event_date: string | null; event_time_text: string | null; order_deadline: string | null;
  venue: string | null; city: string | null; state: string | null; listing_url: string | null;
  image_url: string | null; image_source: string | null; image_credit: string | null; status: string;
};

const PACIFIC = ["CA", "WA", "OR", "NV"], MOUNTAIN = ["CO", "UT", "NM", "WY", "MT", "ID"];
const CENTRAL = ["IL", "WI", "MN", "IA", "MO", "AR", "LA", "MS", "AL", "OK", "KS", "NE", "SD", "ND", "TX", "TN"];
function zoneFor(row: Row) {
  const t = (row.event_time_text || "").toLowerCase();
  if (/\bpt\b|pacific/.test(t)) return "America/Los_Angeles";
  if (/\bmt\b|mountain/.test(t)) return "America/Denver";
  if (/\bct\b|central/.test(t)) return "America/Chicago";
  if (/\bet\b|eastern/.test(t)) return "America/New_York";
  const s = String(row.state || "").trim().toUpperCase();
  if (!s) return SITE_TZ;
  if (s === "AZ") return "America/Phoenix";
  if (s === "HI") return "Pacific/Honolulu";
  if (s === "AK") return "America/Anchorage";
  if (PACIFIC.includes(s)) return "America/Los_Angeles";
  if (MOUNTAIN.includes(s)) return "America/Denver";
  if (CENTRAL.includes(s)) return "America/Chicago";
  if (s === "MI") return "America/Detroit";
  return "America/New_York";
}
function offsetMs(tz: string, t: number) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
}
/** A wall-clock time on a date in a time zone, as a timestamp (ms). */
function zoned(day: string, hhmm: string, tz: string) {
  const [y, m, d] = day.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - offsetMs(tz, guess);
  t = guess - offsetMs(tz, t);
  return t;
}
const dayBefore = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10);
/** Start time from "6:30 pm - 8:00 pm", "Around 6:30 PM PT", "12:30-1:30", "11 am". */
function startTime(text: string | null) {
  const m = String(text || "").toLowerCase().match(/(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/);
  if (!m) return null;
  const h = Number(m[1]), mi = m[2] ? Number(m[2]) : 0;
  if (h < 1 || h > 12 || mi > 59 || (!m[2] && !m[3])) return null;
  let mer = m[3] ? (m[3].startsWith("a") ? "am" : "pm") : null;
  if (!mer) {
    const later = String(text).toLowerCase().slice(m.index! + m[0].length).match(/(a\.?m\.?|p\.?m\.?)/);
    mer = later ? (later[1].startsWith("a") ? "am" : "pm") : h >= 8 && h <= 11 ? "am" : "pm";
  }
  const hour = (h % 12) + (mer === "pm" ? 12 : 0);
  return `${String(hour).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

type Plan = { kind: "event" | "deadline"; remindAt: number; until: number; tz: string; time: string | null };
/** When to remind for a signing, or null when there's nothing left to remind about. */
function plan(row: Row, now = Date.now()): Plan | null {
  const remote = row.signing_type === "mail-in" || row.signing_type === "private";
  const deadlineEnd = row.order_deadline ? zoned(row.order_deadline, "23:59", SITE_TZ) : 0;
  const deadline = (): Plan => ({ kind: "deadline", remindAt: zoned(dayBefore(row.order_deadline!), "09:00", SITE_TZ), until: deadlineEnd, tz: SITE_TZ, time: null });
  if (remote && row.order_deadline) return deadlineEnd > now ? deadline() : null;
  if (row.event_date) {
    const tz = remote ? SITE_TZ : zoneFor(row);
    const time = remote ? null : startTime(row.event_time_text);
    const start = time ? zoned(row.event_date, time, tz) : null;
    const p: Plan = {
      kind: "event",
      remindAt: start ? start - 24 * HOUR : zoned(dayBefore(row.event_date), "09:00", tz),
      until: start ?? zoned(row.event_date, "23:59", tz),
      tz,
      time,
    };
    return p.until > now ? p : null;
  }
  if (row.order_deadline && deadlineEnd > now) return deadline();
  return null;
}

// ---------- email ----------

const LOGO_URL = "https://raw.githubusercontent.com/patterba/autograph-hero/main/assets/email-logo.png";
// Logo band at the top of every email. Hosted on GitHub (not autographhero.com) because the
// site's Cloudflare bot check can block the servers email apps use to load images.
const emailHeader = () =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F6F1E7;border-bottom:2px solid #16181D;margin:0 0 20px"><tr><td width="124" valign="middle" style="padding:10px 0 10px 12px"><a href="https://autographhero.com/"><img src="${LOGO_URL}" width="124" height="74" alt="Autograph Hero" style="display:block;border:0;outline:none;width:124px;height:74px"></a></td><td valign="middle" align="right" style="padding:10px 12px 10px 8px;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:1.2;font-weight:800;color:#C2410C;font-style:italic;white-space:nowrap">Never miss a signing!</td></tr></table>`;
const btn = (href: string, label: string, solid = true) =>
  `<a href="${html(href)}" style="display:inline-block;${solid ? "background:#C2410C;color:#FFFFFF;" : "background:#FFFFFF;color:#16181D;border:1.5px solid #16181D;"}text-decoration:none;font-weight:600;padding:12px 20px;border-radius:999px;margin:0 8px 8px 0">${html(label)}</a>`;

const localDay = (t: number, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(t));
const longDay = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" }).format(new Date(`${iso}T00:00:00Z`));
const clock = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
};

function reminderEmail(r: { email: string; kind: string }, s: Row, p: Plan, now = Date.now()) {
  const names = (s.athlete_names || []).filter((n) => typeof n === "string" && n.trim());
  const name = joinNames(names) || s.title || "Autograph signing";
  const href = `${SITE}/signing/${s.id}-${slugify(name) || "signing"}/`;
  const order = httpsUrl(s.listing_url);
  const host = order ? new URL(order).hostname.replace(/^www\./, "") : "the organizer";
  const shop = s.image_source === "promoter" && s.image_credit ? s.image_credit : host;
  const day = p.kind === "deadline" ? s.order_deadline! : s.event_date!;
  const when = localDay(now, p.tz) === day ? "today" : "tomorrow";
  const where = [s.venue ? String(s.venue).split(",")[0] : "", [s.city, s.state].filter(Boolean).join(", ")].filter(Boolean).join(", ");
  const image = httpsUrl(s.image_url);
  const first = names[0] || "this signer";

  let subject: string, lead: string, textLead: string;
  if (p.kind === "deadline") {
    subject = `Last chance to order: ${name}${when === "today" ? " (deadline today)" : " (deadline tomorrow)"}`;
    lead = `The order deadline for the <strong>${html(name)}</strong> ${s.signing_type === "private" ? "private" : "mail-in"} signing is <strong>${when}, ${html(longDay(day))}</strong>. Order through ${html(shop)} before it closes.`;
    textLead = `The order deadline for the ${name} ${s.signing_type === "private" ? "private" : "mail-in"} signing is ${when}, ${longDay(day)}. Order through ${shop} before it closes.`;
  } else {
    const at = p.time ? ` at ${clock(p.time)}` : "";
    subject = `${when === "today" ? "Today" : "Tomorrow"}: ${name} autograph signing`;
    lead = `<strong>${html(name)}</strong> is signing <strong>${when}, ${html(longDay(day))}${html(at)}</strong>${where ? ` at ${html(where)}` : ""}.`;
    textLead = `${name} is signing ${when}, ${longDay(day)}${at}${where ? ` at ${where}` : ""}.`;
  }

  const body = `<div style="font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#16181D;max-width:560px">
${emailHeader()}
<p style="font-size:13px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#C2410C;margin:0 0 6px">Your reminder</p>
<p style="margin:0 0 16px">${lead}</p>
${image ? `<p style="margin:0 0 16px"><a href="${html(href)}"><img src="${html(image)}" width="240" alt="${html(name)}" style="display:block;width:240px;max-width:100%;height:auto;border-radius:12px;border:1px solid #16181D"></a></p>` : ""}
<p style="margin:0 0 8px">${btn(href, "See the signing")}${order ? btn(order, `${p.kind === "deadline" ? "Order" : "Details"} at ${shop}`, false) : ""}</p>
<p style="font-size:14px;color:#3A3935">Details can change. Check with the organizer before you ${p.kind === "deadline" ? "order" : "go"}.</p>
<p style="font-size:13px;color:#5B5A55;margin-top:24px">You asked for this reminder on Autograph Hero, so this is the only email about it.
Want an email whenever ${html(first)} signs? <a href="${SITE}/signup/?fav=${encodeURIComponent(first)}" style="color:#C2410C">Get alerts</a>.</p>
</div>`;
  const text = [
    textLead,
    "",
    `See the signing: ${href}`,
    ...(order ? [`${p.kind === "deadline" ? "Order" : "Details"} at ${shop}: ${order}`] : []),
    "",
    "Details can change. Check with the organizer first.",
    "",
    "You asked for this reminder on Autograph Hero, so this is the only email about it.",
    `Get an email whenever ${first} signs: ${SITE}/signup/?fav=${encodeURIComponent(first)}`,
  ].join("\n");
  return { from: MAIL_FROM, to: [r.email], subject, html: body, text };
}

// ---------- the page's form ----------

const text = (v: unknown, max: number) => {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
};
const isEmail = (v: string | null) => !!v && v.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
const sitePath = (b: Record<string, unknown>) => (SITE_PATHS.includes(String(b.path ?? "")) ? String(b.path ?? "") : "");
const clientIp = (req: Request) => (req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
const fmtDay = (iso: string, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts }).format(new Date(`${iso}T00:00:00Z`));

// Same visitor hash as site-forms.
async function ipHash(req: Request) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`autographhero:${clientIp(req) || "unknown"}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function overLimit(hash: string) {
  const since = new Date(Date.now() - HOUR).toISOString();
  const r = await db(`reminders?select=id&ip_hash=eq.${hash}&created_at=gte.${encodeURIComponent(since)}`, { headers: { Prefer: "count=exact", Range: "0-0" } });
  return Number((r.headers.get("content-range") || "*/0").split("/")[1]) >= REMIND_HOURLY_LIMIT;
}
// Cloudflare Turnstile, as on site-forms. Off until TURNSTILE_SECRET_KEY is set on this function.
async function captchaOk(token: unknown, req: Request) {
  if (!TURNSTILE_SECRET) return true;
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  const form = new URLSearchParams({ secret: TURNSTILE_SECRET, response: token });
  const ip = clientIp(req);
  if (ip) form.set("remoteip", ip);
  try {
    const j = await (await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form })).json();
    return j.success === true;
  } catch (err) {
    console.error("turnstile check failed", String(err));
    return false;
  }
}

let resendKey: string | null = (Deno.env.get("RESEND_API_KEY") || "").trim() || null;
async function getResendKey() {
  if (!resendKey) resendKey = (await rpcText("site_resend_key")) || null;
  return resendKey;
}
async function sendMail(to: string, subject: string, htmlBody: string, textBody: string) {
  const key = await getResendKey();
  if (!key) { console.warn("reminder confirmation skipped: no Resend key"); return false; }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html: htmlBody, text: textBody }),
  });
  if (!r.ok) console.error("reminder confirmation failed", r.status, await r.text());
  return r.ok;
}

async function remind(b: Record<string, unknown>, req: Request) {
  const id = Number(b.signing_id);
  if (!Number.isInteger(id) || id <= 0) return fail("Something went wrong. Please reload the page and try again.");
  // Logged in: the email comes from the member's own login. Otherwise from the form.
  let email: string | null = null;
  const token = typeof b.access_token === "string" && b.access_token.length < 4096 ? b.access_token : "";
  if (token) {
    const who = await fetch(`${AUTH}/user`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
    if (who.ok) email = String((await who.json()).email || "").toLowerCase() || null;
  }
  if (!email) {
    if (!(await captchaOk(b.captcha_token, req))) return fail("Please complete the quick check, then try again.");
    email = text(b.email, 254)?.toLowerCase() || null;
    if (!isEmail(email)) return fail("Please enter a valid email address.");
  }
  const hash = await ipHash(req);
  if (await overLimit(hash)) return fail("You've set a lot of reminders in the last hour. Please try again later.", 429);

  const sr = await db(`signings?select=${COLS}&id=eq.${id}&status=eq.published`);
  const s = sr.ok ? (await sr.json())[0] as Row | undefined : undefined;
  if (!s) return fail("This signing isn't listed anymore, so there's nothing to remind you about.", 404);
  const now = Date.now();
  const p = plan(s, now);
  if (!p) return fail(s.order_deadline && s.signing_type !== "public" ? "The order deadline for this signing has passed." : "This signing is over.");
  if (p.until - now < HOUR) return fail("This one is less than an hour away, which is too soon for a reminder.");

  const found = await db(`reminders?select=id,status&email=eq.${encodeURIComponent(email!)}&signing_id=eq.${id}`);
  const prev = found.ok ? (await found.json())[0] : null;
  if (prev?.status === "pending") return json(200, { ok: true, already: true, message: `You already have a reminder set for this signing. We'll email ${email}.` });
  const saved = prev
    ? await db(`reminders?id=eq.${prev.id}`, { method: "PATCH", body: JSON.stringify({ status: "pending", sent_at: null, kind: p.kind }), headers: { Prefer: "return=representation" } })
    : await db("reminders", { method: "POST", body: JSON.stringify({ email, signing_id: id, kind: p.kind, ip_hash: hash }), headers: { Prefer: "return=representation" } });
  if (!saved.ok) {
    console.error("reminder save failed", saved.status, await saved.text());
    return fail("We couldn't save that just now. Please try again in a minute.", 500);
  }
  const row = (await saved.json())[0];

  const names = (s.athlete_names || []).filter((n) => typeof n === "string" && n.trim());
  const name = joinNames(names) || s.title || "Autograph signing";
  const path = sitePath(b);
  const href = `${SITE}${path}/signing/${s.id}-${slugify(name) || "signing"}/`;
  const soon = now >= p.remindAt;
  const day = p.kind === "deadline" ? s.order_deadline! : s.event_date!;
  const whenText = soon
    ? "within the hour"
    : p.kind === "deadline"
      ? `the day before the order deadline (${fmtDay(day, { month: "short", day: "numeric" })})`
      : p.time ? "24 hours before it starts" : "the day before";
  // A confirmation with a cancel link, unless the reminder itself is about to go out.
  if (!soon && row?.cancel_token) {
    const cancel = `${SITE}${path}/reminder/?cancel=${encodeURIComponent(row.cancel_token)}`;
    const what = p.kind === "deadline" ? `the ${name} signing's order deadline, ${longDay(day)}` : `the ${name} signing on ${longDay(day)}`;
    await sendMail(email!, `Reminder set: ${name}`,
      `<div style="font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#16181D;max-width:560px">${emailHeader()}
<p><strong>Your reminder is set.</strong></p>
<p>We'll email you ${html(whenText)} about ${html(what)}.</p>
<p>${btn(href, "See the signing")}</p>
<p style="font-size:14px;color:#5B5A55">Didn't ask for this, or changed your mind? <a href="${html(cancel)}" style="color:#C2410C">Cancel this reminder</a>.</p>
<p style="font-size:14px;color:#5B5A55">— Autograph Hero</p></div>`,
      ["Your reminder is set.", "", `We'll email you ${whenText} about ${what}.`, "", `See the signing: ${href}`, "", `Didn't ask for this, or changed your mind? Cancel it: ${cancel}`, "", "— Autograph Hero"].join("\n"));
  }
  return json(200, { ok: true, message: `Reminder set! We'll email ${email} ${whenText}.` });
}

async function cancelReminder(b: Record<string, unknown>) {
  const token = String(b.token || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) return fail("That link doesn't look right.");
  const r = await db(`reminders?cancel_token=eq.${token}&select=id`, { method: "DELETE", headers: { Prefer: "return=representation" } });
  const rows = r.ok ? await r.json() : [];
  if (!rows.length) return fail("We couldn't find that reminder. It may already have been canceled or sent.", 404);
  return json(200, { ok: true, message: "Done. That reminder is canceled, and you won't get an email about it." });
}

// ---------- run ----------

const COLS = "id,title,athlete_names,signing_type,event_date,event_time_text,order_deadline,venue,city,state,listing_url,image_url,image_source,image_credit,status";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json(404, { ok: false });

  // The signing page's form (no secret header).
  if (!req.headers.get("x-cron-secret")) {
    let b: Record<string, unknown>;
    try {
      const raw = await req.text();
      if (raw.length > 8000) return fail("That's too much text.");
      b = JSON.parse(raw);
    } catch {
      return fail("Something went wrong sending the form. Please try again.");
    }
    if (b.form === "cancel_reminder") return cancelReminder(b);
    if (b.form !== "remind") return fail("Unknown form.");
    // Bots: the hidden "website" field must stay empty and the button can't be pressed instantly.
    if (b.website || Number(b.elapsed_ms) < MIN_FILL_MS) return json(200, { ok: true, message: "Thanks!" });
    return remind(b, req);
  }

  // The hourly run.
  const secret = await rpcText("site_cron_secret");
  if (!secret || req.headers.get("x-cron-secret") !== secret) return json(401, { ok: false });
  const opts = await req.json().catch(() => ({})) as { only?: string; force?: boolean; dry?: boolean };
  const now = Date.now();

  let q = `reminders?select=id,email,kind,signing:signings(${COLS})&status=eq.pending&limit=5000`;
  if (opts.only) q += `&email=eq.${encodeURIComponent(String(opts.only).toLowerCase())}`;
  const rr = await db(q);
  if (!rr.ok) return json(500, { ok: false, error: await rr.text() });
  const rows = await rr.json() as { id: number; email: string; kind: string; signing: Row | null }[];

  const due: { id: number; email: string; payload: ReturnType<typeof reminderEmail> }[] = [];
  const missed: number[] = [];
  const report: { id: number; email: string; signing?: number; action: string; remindAt?: string }[] = [];
  for (const r of rows) {
    const s = r.signing;
    const p = s && s.status === "published" ? plan(s, now) : null;
    if (!s || !p) { missed.push(r.id); report.push({ id: r.id, email: r.email, signing: s?.id, action: "missed (over or no longer listed)" }); continue; }
    if (now < p.remindAt && !opts.force) { report.push({ id: r.id, email: r.email, signing: s.id, action: "waiting", remindAt: new Date(p.remindAt).toISOString() }); continue; }
    due.push({ id: r.id, email: r.email, payload: reminderEmail(r, s, p, now) });
    report.push({ id: r.id, email: r.email, signing: s.id, action: opts.dry ? "would send" : "send" });
  }
  if (opts.dry) return json(200, { ok: true, dry: true, due: due.length, missed: missed.length, report, sample: due[0]?.payload.subject });

  const resendKey = (Deno.env.get("RESEND_API_KEY") || "").trim() || (await rpcText("site_resend_key"));
  let sent = 0;
  if (due.length && !resendKey) return json(500, { ok: false, error: "no Resend key" });
  for (let i = 0; i < due.length; i += 100) {
    const chunk = due.slice(i, i + 100);
    const r = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(chunk.map((c) => c.payload)),
    });
    if (!r.ok) { console.error("reminder batch failed", r.status, await r.text()); continue; }
    await db(`reminders?id=in.(${chunk.map((c) => c.id).join(",")})`, {
      method: "PATCH", body: JSON.stringify({ status: "sent", sent_at: new Date().toISOString() }), headers: { Prefer: "return=minimal" },
    });
    sent += chunk.length;
    await new Promise((ok) => setTimeout(ok, 600)); // stay under Resend's rate limit
  }
  if (missed.length) {
    await db(`reminders?id=in.(${missed.join(",")})`, {
      method: "PATCH", body: JSON.stringify({ status: "missed", sent_at: new Date().toISOString() }), headers: { Prefer: "return=minimal" },
    });
  }
  // Keep nothing longer than needed: done reminders go 30 days after they were sent or skipped.
  await db(`reminders?status=neq.pending&sent_at=lt.${encodeURIComponent(new Date(now - 30 * 86400_000).toISOString())}`, {
    method: "DELETE", headers: { Prefer: "return=minimal" },
  });
  console.log(`signing reminders: ${sent} sent, ${missed.length} missed, ${rows.length - sent - missed.length} waiting`);
  return json(200, { ok: true, sent, missed: missed.length, waiting: rows.length - due.length - missed.length, report: opts.only ? report : undefined });
});
