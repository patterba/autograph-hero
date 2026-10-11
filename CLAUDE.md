# Notes for Claude

- Static site, zero dependencies. `node build.mjs` writes `dist/`. Do not add a framework or npm packages without asking.
- Data comes from Supabase project `ravavlocylqvkmthevtv`: `public.signings` (rows with status 'published') and `public.athletes` (each signer's pro teams from Wikipedia, rows with status 'confirmed'). The weekly crawl scheduled task fills both. Team names feed search and the cards.
- Photos: the promoter's photo (signings.image_url) comes first; the player's free Wikimedia Commons photo (athletes.image_url) is the backup, also swapped in by the browser if the promoter photo fails. Commons photos are credited on the signing page and on /photo-credits/. The Supabase function `athlete-photos` finds them; the workflow calls it before each build.
- All text from the database is scraped from other websites: always pass it through `esc()` and URLs through `safeUrl()`.
- Internal links go through `link()` so the site works in a sub-folder (e.g. /new on Bluehost) and at the domain root.
- Hosting is Bluehost (Apache). The workflow uploads over FTP; the build writes an .htaccess.
- Design tokens are CSS variables at the top of `assets/site.css`.
