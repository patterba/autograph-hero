// Adds a public.athletes row (Wikipedia article, pro teams, free Commons photo) for signers
// who don't have one yet, so fan-submitted signings get team names and a photo like crawled ones.
//
// Called by admin.approve_submission() through pg_net right after a fan submission is approved
// (body {"signing_id": N}), and hourly by pg_cron (body {}) to sweep any upcoming published
// signing whose signers still have no athletes row. Header x-cron-secret = Vault
// 'weekly_alerts_secret' (public.site_cron_secret()). JWT verification is off; the secret is the check.
// Test with {"name": "Kam Chancellor", "sport": "Football", "dry": true} (dry = report only).
//
// Rules:
// - Only an article whose title is the signer's name (ignoring case, accents and a
//   "(American football)" style suffix) and whose infobox fits the sport counts as a match.
//   A match with teams is saved 'confirmed'; anything less is saved 'pending_review' with a
//   note, so the weekly crawl / the owner can check it.
// - Teams are pro stints from the infobox: {team, league, role, from_year, to_year}.
//   League comes from teams already in public.athletes, else the built-in major-league list,
//   else null (team still shows as text and matches search, but gets no team page).
// - When the article title only differs from the submitted name in capitals or accents
//   ("Kam chancellor"), the fan-submitted signing is updated to the proper spelling.
// - Photos: lead image of the article, only if Commons says it is freely licensed.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const DB = `${Deno.env.get("SUPABASE_URL")}/rest/v1`;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const UA = "AutographHeroBot/1.0 (https://autographhero.com; signer info lookup)";
const FREE = /^(cc0|cc[ -]by(-sa)?\b|public domain|pd\b)/i;
const FAN_SOURCE_URL = "https://autographhero.com/add/";
const SWEEP_LIMIT = 15;

const json = (status: number, body: unknown) => Response.json(body, { status });
const db = (path: string, init: RequestInit = {}) =>
  fetch(`${DB}/${path}`, {
    ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });

async function rpcText(name: string) {
  const r = await db(`rpc/${name}`, { method: "POST", body: "{}" });
  const v = r.ok ? await r.json() : null;
  return typeof v === "string" ? v.trim() : "";
}

async function wiki(host: string, params: Record<string, string>) {
  const url = `https://${host}/w/api.php?${new URLSearchParams({ format: "json", formatversion: "2", ...params })}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${host} returned ${res.status}`);
  return await res.json();
}

const fold = (s: string) => String(s).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[.'’]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const baseTitle = (t: string) => t.replace(/\s*\([^)]*\)\s*$/, "").trim();

// ---------- sport rules ----------

const SPORT: Record<string, { search: string; infobox: RegExp; league: string | null }> = {
  Football: { search: "American football", infobox: /NFL|American football|gridiron|CFL/i, league: "NFL" },
  Baseball: { search: "baseball", infobox: /baseball/i, league: "MLB" },
  Basketball: { search: "basketball", infobox: /basketball/i, league: "NBA" },
  Hockey: { search: "ice hockey", infobox: /ice hockey|hockey/i, league: "NHL" },
  Soccer: { search: "soccer", infobox: /football biography|soccer/i, league: "MLS" },
  Wrestling: { search: "wrestler", infobox: /wrestler/i, league: null },
  MMA: { search: "mixed martial artist", infobox: /martial art/i, league: null },
  Golf: { search: "golfer", infobox: /golfer/i, league: null },
  Racing: { search: "racing driver", infobox: /racing driver|NASCAR|motorsport/i, league: null },
};

// Major-league clubs, current and recent former names. Used only when a team isn't already
// in public.athletes with a league.
const MAJOR: Record<string, string> = {};
const add = (league: string, names: string) => names.split(";").forEach((n) => (MAJOR[n.trim()] = league));
add("NFL", "Arizona Cardinals;Atlanta Falcons;Baltimore Ravens;Buffalo Bills;Carolina Panthers;Chicago Bears;Cincinnati Bengals;Cleveland Browns;Dallas Cowboys;Denver Broncos;Detroit Lions;Green Bay Packers;Houston Texans;Indianapolis Colts;Jacksonville Jaguars;Kansas City Chiefs;Las Vegas Raiders;Los Angeles Chargers;Los Angeles Rams;Miami Dolphins;Minnesota Vikings;New England Patriots;New Orleans Saints;New York Giants;New York Jets;Philadelphia Eagles;Pittsburgh Steelers;San Francisco 49ers;Seattle Seahawks;Tampa Bay Buccaneers;Tennessee Titans;Washington Commanders;Oakland Raiders;Los Angeles Raiders;San Diego Chargers;St. Louis Rams;St. Louis Cardinals (NFL);Phoenix Cardinals;Houston Oilers;Tennessee Oilers;Baltimore Colts;Washington Redskins;Washington Football Team;Boston Patriots");
add("MLB", "Arizona Diamondbacks;Atlanta Braves;Baltimore Orioles;Boston Red Sox;Chicago Cubs;Chicago White Sox;Cincinnati Reds;Cleveland Guardians;Cleveland Indians;Colorado Rockies;Detroit Tigers;Houston Astros;Kansas City Royals;Los Angeles Angels;Anaheim Angels;California Angels;Los Angeles Angels of Anaheim;Los Angeles Dodgers;Brooklyn Dodgers;Miami Marlins;Florida Marlins;Milwaukee Brewers;Minnesota Twins;New York Mets;New York Yankees;Athletics;Oakland Athletics;Sacramento Athletics;Philadelphia Phillies;Pittsburgh Pirates;San Diego Padres;San Francisco Giants;New York Giants (baseball);Seattle Mariners;St. Louis Cardinals;Tampa Bay Rays;Tampa Bay Devil Rays;Texas Rangers;Toronto Blue Jays;Washington Nationals;Montreal Expos");
add("NBA", "Atlanta Hawks;Boston Celtics;Brooklyn Nets;New Jersey Nets;Charlotte Hornets;Charlotte Bobcats;Chicago Bulls;Cleveland Cavaliers;Dallas Mavericks;Denver Nuggets;Detroit Pistons;Golden State Warriors;Houston Rockets;Indiana Pacers;LA Clippers;Los Angeles Clippers;San Diego Clippers;Los Angeles Lakers;Memphis Grizzlies;Vancouver Grizzlies;Miami Heat;Milwaukee Bucks;Minnesota Timberwolves;New Orleans Pelicans;New Orleans Hornets;New York Knicks;Oklahoma City Thunder;Seattle SuperSonics;Orlando Magic;Philadelphia 76ers;Phoenix Suns;Portland Trail Blazers;Sacramento Kings;San Antonio Spurs;Toronto Raptors;Utah Jazz;Washington Wizards;Washington Bullets");
add("NHL", "Anaheim Ducks;Mighty Ducks of Anaheim;Boston Bruins;Buffalo Sabres;Calgary Flames;Carolina Hurricanes;Hartford Whalers;Chicago Blackhawks;Colorado Avalanche;Quebec Nordiques;Columbus Blue Jackets;Dallas Stars;Minnesota North Stars;Detroit Red Wings;Edmonton Oilers;Florida Panthers;Los Angeles Kings;Minnesota Wild;Montreal Canadiens;Nashville Predators;New Jersey Devils;New York Islanders;New York Rangers;Ottawa Senators;Philadelphia Flyers;Pittsburgh Penguins;San Jose Sharks;Seattle Kraken;St. Louis Blues;Tampa Bay Lightning;Toronto Maple Leafs;Utah Hockey Club;Utah Mammoth;Arizona Coyotes;Phoenix Coyotes;Winnipeg Jets;Atlanta Thrashers;Vancouver Canucks;Vegas Golden Knights;Washington Capitals");

// ---------- infobox parsing ----------

// The first {{Infobox ...}} template, with its type and top-level parameters.
function infobox(wikitext: string): { type: string; params: Map<string, string> } | null {
  const start = wikitext.search(/\{\{\s*Infobox/i);
  if (start < 0) return null;
  let depth = 0, end = -1;
  for (let i = start; i < wikitext.length - 1; i++) {
    const two = wikitext.slice(i, i + 2);
    if (two === "{{") { depth++; i++; } else if (two === "}}") { depth--; i++; if (depth === 0) { end = i + 1; break; } }
  }
  const body = wikitext.slice(start + 2, end > 0 ? end - 2 : undefined);
  const parts: string[] = [];
  let cur = "", d = 0;
  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2);
    if (two === "{{" || two === "[[") { d++; cur += two; i++; continue; }
    if (two === "}}" || two === "]]") { d--; cur += two; i++; continue; }
    if (body[i] === "|" && d === 0) { parts.push(cur); cur = ""; continue; }
    cur += body[i];
  }
  parts.push(cur);
  const type = parts.shift()!.replace(/^\s*Infobox\s*/i, "").trim();
  const params = new Map<string, string>();
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq > 0) params.set(p.slice(0, eq).trim().toLowerCase(), p.slice(eq + 1).trim());
  }
  return { type, params };
}

// [[Target|Shown]] → team name. Season links ("2010 Seattle Seahawks season|Seattle Seahawks") use the shown text.
function teamName(s: string): string | null {
  const m = s.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
  let name: string;
  if (m) {
    const target = m[1].trim(), shown = (m[2] || "").trim();
    name = /\bseason\b/i.test(target) || /^\d{4}/.test(target) ? shown || target : target;
  } else {
    name = s.replace(/\{\{[^}]*\}\}/g, "").replace(/\([^)]*\)/g, "").replace(/'''?/g, "").replace(/<[^>]+>/g, "").trim();
  }
  name = name.replace(/\s*\((?!NFL\)|baseball\))[^)]*\)\s*$/, "").replace(/[*#:]/g, "").trim();
  if (!name || name.length > 60 || /^(as |none|n\/a|free agent)/i.test(name)) return null;
  return name;
}

function yearsOf(s: string): { from: number | null; to: number | null } {
  const ys = [...s.matchAll(/\b(1[89]\d{2}|20\d{2})\b/g)].map((m) => Number(m[1]));
  const present = /present/i.test(s);
  if (!ys.length) return { from: null, to: null };
  return { from: ys[0], to: present ? null : ys[ys.length - 1] };
}

type Stint = { team: string; league: string | null; role: "player" | "coach"; from_year: number | null; to_year: number | null };

function parseTeams(params: Map<string, string>): Stint[] {
  const out: Stint[] = [];
  const push = (team: string | null, role: "player" | "coach", yrs: { from: number | null; to: number | null }) => {
    if (!team) return;
    if (/\b(university|college|high school|academy)\b/i.test(team)) return;
    out.push({ team, league: null, role, from_year: yrs.from, to_year: yrs.to });
  };

  // 1. Bulleted lists: pastteams / teams / past_teams, with "As player" / "As coach" headings.
  for (const key of ["pastteams", "past_teams", "teams", "playing_teams", "coach_teams", "coaching_teams", "pastcoaching"]) {
    const v = params.get(key);
    if (!v) continue;
    let role: "player" | "coach" = /coach/.test(key) ? "coach" : "player";
    const lines = v.replace(/\{\{\s*(?:plainlist|ubl|unbulleted list|flatlist)\s*\|/gi, "\n").split(/\n|<br\s*\/?>/i);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (/as\s+(a\s+)?(player|playing)/i.test(line) && !/\[\[/.test(line)) { role = "player"; continue; }
      if (/as\s+(a\s+)?(coach|manager|executive|staff)/i.test(line) && !/\[\[/.test(line)) { role = "coach"; continue; }
      if (/as\s+(an?\s+)?(executive|broadcaster|owner)/i.test(line)) { role = "coach"; continue; }
      if (!/\[\[/.test(line)) continue;
      const after = line.slice(line.indexOf("]]") + 2);
      push(teamName(line), role, yearsOf(after));
    }
  }

  // 2. Numbered pairs: years1/team1 (players), coach_years1/coach_team1 (coaches).
  for (const [yKey, tKey, role] of [["years", "team", "player"], ["coach_years", "coach_team", "coach"], ["coachyears", "coachteam", "coach"]] as const) {
    for (let i = 1; i <= 40; i++) {
      const t = params.get(`${tKey}${i}`);
      if (!t) continue;
      push(teamName(t), role, yearsOf(params.get(`${yKey}${i}`) || ""));
    }
  }

  // 3. Hockey: played_for = [[A]]<br>[[B]] (no years).
  if (!out.length && params.get("played_for")) {
    for (const m of params.get("played_for")!.matchAll(/\[\[[^\]]+\]\]/g)) push(teamName(m[0]), "player", { from: null, to: null });
  }

  // 4. Active player with only "current_team".
  if (!out.some((s) => s.role === "player") && params.get("current_team")) {
    push(teamName(params.get("current_team")!), "player", yearsOf(params.get("years") || params.get("debutyear") || ""));
  }

  // Drop exact repeats, keep career order.
  const seen = new Set<string>();
  return out.filter((s) => { const k = `${s.team}|${s.role}|${s.from_year}|${s.to_year}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// ---------- lookups ----------

async function findArticle(name: string, sport: string | null) {
  const rule = (sport && SPORT[sport]) || null;
  const want = fold(name);
  const queries = [rule ? `${name} ${rule.search}` : name, name];
  const titles: string[] = [];
  for (const q of queries) {
    const s = await wiki("en.wikipedia.org", { action: "query", list: "search", srsearch: q, srlimit: "6", srnamespace: "0" });
    for (const r of s.query?.search || []) if (!titles.includes(r.title)) titles.push(r.title);
  }
  // Also try the exact title (search can miss a disambiguation-less exact page).
  const candidates = [...new Set([...titles.filter((t) => fold(baseTitle(t)) === want), name])];
  if (!candidates.length) return null;
  const r = await wiki("en.wikipedia.org", {
    action: "query", redirects: "1", prop: "revisions|pageprops", rvprop: "content", rvslots: "main",
    titles: candidates.slice(0, 10).join("|"),
  });
  let fallback: any = null;
  for (const p of r.query?.pages || []) {
    if (p.missing || p.pageprops?.disambiguation !== undefined) continue;
    if (fold(baseTitle(p.title)) !== want) continue;
    const text = p.revisions?.[0]?.slots?.main?.content || "";
    const box = infobox(text);
    const fits = Boolean(box && (!rule || rule.infobox.test(box.type)));
    const hit = { title: p.title as string, box, fits };
    if (fits) return hit;
    fallback ||= hit;
  }
  return fallback;
}

async function commonsPhoto(title: string) {
  const w = await wiki("en.wikipedia.org", { action: "query", redirects: "1", prop: "pageimages", piprop: "name", titles: title });
  const file = w.query?.pages?.[0]?.pageimage;
  if (!file) return null;
  const c = await wiki("commons.wikimedia.org", { action: "query", prop: "imageinfo", iiprop: "url|extmetadata", iiurlwidth: "800", titles: `File:${file}` });
  const ii = c.query?.pages?.[0]?.imageinfo?.[0];
  if (!ii) return null; // local (non-free) Wikipedia file
  const strip = (h: unknown) => String(h ?? "").replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, " ").trim();
  const tidy = (s: string) => s.replace(/\s*\(?\s*talk\s*(•|·|\|)?\s*contribs\s*\)?/gi, "").replace(/^(.+?)\1$/, "$1").replace(/\s+/g, " ").trim();
  const meta = ii.extmetadata || {};
  const license = strip(meta.LicenseShortName?.value);
  if (!FREE.test(license) || String(meta.NonFree?.value || "").toLowerCase() === "true") return null;
  return {
    image_url: ii.thumburl || ii.url,
    image_page_url: ii.descriptionurl,
    image_credit: tidy(strip(meta.Artist?.value)) || tidy(strip(meta.Credit?.value)) || "Wikimedia Commons",
    image_license: license,
  };
}

async function knownLeagues() {
  const m = new Map<string, string>();
  const r = await db("athletes?select=teams&limit=5000");
  for (const a of r.ok ? await r.json() : []) for (const t of a.teams || []) if (t?.team && t.league) m.set(t.team, t.league);
  return m;
}

async function enrich(name: string, sport: string | null, leagues: Map<string, string>, dry: boolean) {
  const now = new Date().toISOString();
  const hit = await findArticle(name, sport);
  const row: Record<string, unknown> = { name, sport: sport || "Other", checked_at: now, updated_at: now, teams: [], status: "pending_review" };
  if (!hit) {
    row.review_note = "Auto lookup on approval: no Wikipedia article with this name. Check by hand.";
  } else {
    const teams = hit.box ? parseTeams(hit.box.params) : [];
    for (const t of teams) t.league = leagues.get(t.team) || MAJOR[t.team] || null;
    row.name = baseTitle(hit.title);
    row.wikipedia_url = `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, "_"))}`;
    row.teams = teams;
    if (hit.fits && teams.length) {
      row.status = "confirmed";
      row.review_note = `Auto lookup on approval: article "${hit.title}".`;
    } else if (hit.fits) {
      // Team sports should list teams; individual sports (wrestling, golf...) have none.
      row.status = sport && SPORT[sport] && !SPORT[sport].league ? "confirmed" : "pending_review";
      row.review_note = `Auto lookup on approval: article "${hit.title}", no pro teams found in the infobox.`;
    } else {
      row.review_note = `Auto lookup on approval: article "${hit.title}" found but its infobox (${hit.box?.type || "none"}) doesn't look like ${sport || "this sport"}. Check it's the right person.`;
    }
    const photo = await commonsPhoto(hit.title).catch(() => undefined);
    if (photo !== undefined) row.image_checked_at = now; // undefined = Commons unreachable; athlete-photos retries
    if (photo) Object.assign(row, photo);
  }
  if (!dry) {
    const r = await db("athletes", { method: "POST", body: JSON.stringify(row), headers: { Prefer: "return=minimal" } });
    if (!r.ok) throw new Error(`saving ${name}: ${r.status} ${await r.text()}`);
  }
  return row;
}

// Signers of the given signings (or of all upcoming published ones) that have no athletes row.
async function missing(signingId: number | null) {
  let q = "signings?select=id,athlete_names,sport,title,source_id&status=eq.published";
  q += signingId ? `&id=eq.${signingId}` : `&or=(event_date.gte.${new Date().toISOString().slice(0, 10)},order_deadline.gte.${new Date().toISOString().slice(0, 10)})&limit=2000`;
  const sr = await db(q);
  if (!sr.ok) throw new Error(`reading signings: ${sr.status}`);
  const signings = await sr.json();
  const ar = await db("athletes?select=name&limit=10000");
  const have = new Set((ar.ok ? await ar.json() : []).map((a: any) => fold(a.name)));
  const todo = new Map<string, { name: string; sport: string | null }>();
  for (const s of signings) for (const n of s.athlete_names || []) {
    if (typeof n !== "string" || !n.trim() || have.has(fold(n)) || todo.has(fold(n))) continue;
    todo.set(fold(n), { name: n.trim(), sport: s.sport || null });
  }
  return { signings, todo: [...todo.values()] };
}

// Put the article's spelling on fan-submitted signings ("Kam chancellor" → "Kam Chancellor").
async function fixSpelling(signings: any[], fixed: Map<string, string>) {
  const sources = await db(`sources?select=id&signing_url=eq.${encodeURIComponent(FAN_SOURCE_URL)}`);
  const fanSource = (sources.ok ? await sources.json() : [])[0]?.id;
  let n = 0;
  for (const s of signings) {
    if (s.source_id !== fanSource) continue;
    const names: string[] = s.athlete_names || [];
    const next = names.map((x) => fixed.get(fold(x)) || x);
    if (next.every((x, i) => x === names[i])) continue;
    const patch: Record<string, unknown> = { athlete_names: next, updated_at: new Date().toISOString() };
    if (s.title === `${names.join(" & ")} Autograph Signing`) patch.title = `${next.join(" & ")} Autograph Signing`;
    const r = await db(`signings?id=eq.${s.id}`, { method: "PATCH", body: JSON.stringify(patch), headers: { Prefer: "return=minimal" } });
    if (r.ok) n++;
  }
  return n;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(404, { ok: false });
  const secret = await rpcText("site_cron_secret");
  if (!secret || req.headers.get("x-cron-secret") !== secret) return json(401, { ok: false });
  const opts = await req.json().catch(() => ({})) as { signing_id?: number; name?: string; sport?: string; dry?: boolean };
  const dry = Boolean(opts.dry);
  try {
    const leagues = await knownLeagues();
    if (opts.name) return json(200, { ok: true, dry, athlete: await enrich(String(opts.name).trim(), opts.sport || null, leagues, dry) });

    const signingId = Number.isInteger(opts.signing_id) ? opts.signing_id! : null;
    const { signings, todo } = await missing(signingId);
    const added: unknown[] = [];
    const errors: string[] = [];
    const fixed = new Map<string, string>();
    for (const t of todo.slice(0, SWEEP_LIMIT)) {
      try {
        const row = await enrich(t.name, t.sport, leagues, dry);
        added.push({ name: row.name, status: row.status, teams: (row.teams as unknown[]).length, photo: Boolean(row.image_url), note: row.review_note });
        if (row.name !== t.name && fold(String(row.name)) === fold(t.name)) fixed.set(fold(t.name), String(row.name));
      } catch (e) {
        errors.push(`${t.name}: ${e}`);
      }
    }
    const renamed = dry ? 0 : await fixSpelling(signings, fixed);
    return json(200, { ok: true, dry, checked: todo.length, added, renamed, errors });
  } catch (err) {
    return json(502, { ok: false, error: String(err) });
  }
});
