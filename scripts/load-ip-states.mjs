// Loads public.ip_states (US IP ranges -> state) from DB-IP IP to City Lite (CC BY 4.0, https://db-ip.com),
// via the npm package @ip-location-db/dbip-city. Run by .github/workflows/load-ip-states.yml.
// Needs SUPABASE_URL and SUPABASE_READ_KEY (a secret key: it writes past RLS).
import { execSync } from 'node:child_process';
import { createReadStream, mkdtempSync, readdirSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const URL_ = (process.env.SUPABASE_URL || 'https://ravavlocylqvkmthevtv.supabase.co').replace(/\/$/, '');
const KEY = process.env.SUPABASE_READ_KEY;
if (!KEY) throw new Error('SUPABASE_READ_KEY missing');
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' };

const dir = mkdtempSync(join(tmpdir(), 'dbip-'));
execSync('npm pack @ip-location-db/dbip-city --silent', { cwd: dir, stdio: 'inherit' });
execSync('tar xzf *.tgz', { cwd: dir, shell: '/bin/bash' });
const pkg = join(dir, 'package');

function toBig(ip) {
  if (ip.includes('.') && !ip.includes(':')) return ip.split('.').reduce((n, p) => n * 256n + BigInt(p), 0n);
  let [a, b = ''] = ip.split('::');
  const A = a ? a.split(':') : [], B = b ? b.split(':') : [];
  const parts = ip.includes('::') ? [...A, ...Array(8 - A.length - B.length).fill('0'), ...B] : A;
  return parts.reduce((n, p) => n * 65536n + BigInt(parseInt(p || '0', 16)), 0n);
}

async function read(file) {
  const out = [];
  const rl = createInterface({ input: createReadStream(join(pkg, file)).pipe(createGunzip()) });
  for await (const line of rl) {
    const c = line.split(',');
    if (c[2] !== 'US' || !c[3]) continue;
    const last = out[out.length - 1];
    if (last && last.state === c[3] && last.endN + 1n === toBig(c[0])) { last.end_ip = c[1]; last.endN = toBig(c[1]); }
    else out.push({ start_ip: c[0], end_ip: c[1], state: c[3], endN: toBig(c[1]) });
  }
  return out;
}

const files = readdirSync(pkg).filter((f) => /^dbip-city-ipv[46]\.csv\.gz$/.test(f));
let rows = [];
for (const f of files) { const r = await read(f); console.log(f, r.length, 'US ranges'); rows = rows.concat(r); }
if (rows.length < 100000) throw new Error('Too few rows, stopping: ' + rows.length);

let res = await fetch(`${URL_}/rest/v1/ip_states?start_ip=not.is.null`, { method: 'DELETE', headers: H });
if (!res.ok) throw new Error('clear failed ' + res.status + ' ' + await res.text());
for (let i = 0; i < rows.length; i += 5000) {
  const body = JSON.stringify(rows.slice(i, i + 5000).map(({ start_ip, end_ip, state }) => ({ start_ip, end_ip, state })));
  for (let tries = 0; ; tries++) {
    res = await fetch(`${URL_}/rest/v1/ip_states`, { method: 'POST', headers: H, body });
    if (res.ok) break;
    if (tries >= 3) throw new Error('insert failed ' + res.status + ' ' + await res.text());
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (i % 100000 === 0) console.log('loaded', i + 5000);
}
console.log('done', rows.length);
