# Notes for Claude

- Static site, zero dependencies. `node build.mjs` writes `dist/`. Do not add a framework or npm packages without asking.
- Data comes from Supabase project `ravavlocylqvkmthevtv`, table `public.signings`. The site only reads rows the public key can see (status = 'published').
- All text from the database is scraped from other websites: always pass it through `esc()` and URLs through `safeUrl()`.
- Internal links go through `link()` so the site works in a sub-folder (e.g. /new on Bluehost) and at the domain root.
- Hosting is Bluehost (Apache). The workflow uploads over FTP; the build writes an .htaccess.
- Design tokens are CSS variables at the top of `assets/site.css`.
