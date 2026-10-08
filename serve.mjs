// Serves the built site from ./dist at http://localhost:3000 for local preview.
// Run `npm start` to build from Supabase and serve in one step.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const PORT = Number(process.env.PORT) || 3000;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ics': 'text/calendar; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

async function resolve(urlPath) {
  const file = path.join(DIST, path.normalize(decodeURIComponent(urlPath)));
  if (!file.startsWith(DIST)) return null;
  try {
    const info = await stat(file);
    if (info.isDirectory()) return resolve(path.posix.join(urlPath, 'index.html'));
    return file;
  } catch {
    return null;
  }
}

http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (!pathname.endsWith('/') && !path.extname(pathname) && (await resolve(pathname + '/'))) {
    res.writeHead(301, { location: pathname + '/' });
    return res.end();
  }
  const file = await resolve(pathname);
  if (!file) {
    res.writeHead(404, { 'content-type': TYPES['.html'] });
    return res.end(await readFile(path.join(DIST, '404.html')).catch(() => 'Not found'));
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(await readFile(file));
}).listen(PORT, () => {
  console.log(`Autograph Hero is running at http://localhost:${PORT}  (press Ctrl+C to stop)`);
});
