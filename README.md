# Autograph Hero

The Autograph Hero website. It lists upcoming autograph signings that are stored in the Supabase project "AutographHero Data".

## How it works

1. A scheduled task crawls the source pages every Monday and Friday and saves signings to the `signings` table in Supabase.
2. `build.mjs` reads every signing whose status is `published` and each signer's teams from the `athletes` table, drops the signings that are over, and writes a plain HTML site into `dist/`. Searching a team ("Broncos") finds its players.
3. GitHub Actions (`.github/workflows/publish.yml`) runs that build on every push to `main` and every hour, then uploads `dist/` to Bluehost over FTP.

The upload needs three repository secrets (Settings → Secrets and variables → Actions): `FTP_SERVER`, `FTP_USERNAME` and `FTP_PASSWORD`. Use a Bluehost FTP account whose directory is the site folder (for testing, `public_html/new`), so the upload cannot reach anything else. Bluehost's FTP certificate doesn't match the account hostname, so the workflow trusts that one certificate by its fingerprint; if Bluehost renews it, the upload log shows the new fingerprint, which goes in the repository variable `FTP_CERT_FINGERPRINT`.

## Run it on your computer

You need [Node.js](https://nodejs.org) version 20 or newer. Nothing else to install.

```
npm start
```

This pulls the latest signings from Supabase, builds the site and serves it at http://localhost:3000. Press Ctrl+C to stop. After you change a file, stop it and run `npm start` again.

## Forms

- **Submit a signing** (`/add/`) saves to `public.submissions` with status `pending`. Nothing goes live until it is approved: `select admin.approve_submission(<id>)` copies it into `signings` as published (filed under the "Fan submission" source), or `select admin.reject_submission(<id>, 'reason')`. The private approval page does the same with buttons.
- **Sign Up** (`/signup/`) saves name, email and favorites to `public.subscribers` (one row per email; signing up again adds favorites).
- **Spam check on Submit a signing:** Cloudflare Turnstile. It switches on when both keys are set: the site key as the GitHub repository variable `TURNSTILE_SITE_KEY` (Settings → Secrets and variables → Actions → Variables), and the secret key as the Supabase Edge Function secret `TURNSTILE_SECRET_KEY`. Add the GitHub variable first; if only the secret is set, the function rejects submissions because the form has no check to send.
- Both go through the Supabase function `site-forms`, which validates, drops bots (hidden field, minimum fill time) and limits each visitor to 5 sends an hour. Both tables are private.

## The app (Add to Home Screen)

The site installs as an app on iPhone, iPad and Android: its own icon, a launch screen, full screen with no browser bars, and pages you've opened keep working with no signal. People install it from the browser (Safari: Share → Add to Home Screen; Chrome: Install). Phones get a small "Get the app" banner a few seconds after a page opens (closing it hides it for two weeks), and **/app/** explains it, linked as "Get the App" in the footer.

- `manifest.webmanifest`, `sw.js` (the offline worker) and `/offline/` are written by `build.mjs` (`manifest()`, `serviceWorker()`, `offlinePage()`), and iOS tags by `appHead()` in every page's `<head>`.
- `assets/app.js` registers the worker and runs the banner and the /app/ page.
- `assets/app/` holds the icons and iPhone/iPad launch screens, drawn from the caped H in `assets/logo.svg`. Re-render them if the logo changes.
- Pages are always fetched fresh when online, so the hourly rebuild reaches installed apps. Bump `VERSION` in `serviceWorker()` only to drop everyone's saved copies.

## Where things live

| File | What it is |
| --- | --- |
| `build.mjs` | Fetches the data and holds the page templates (home, all signings, one page per signing) |
| `assets/site.css` | All styling. Colors and fonts are variables at the top |
| `assets/site.js` | The search and filters on the "All signings" page |
| `assets/forms.js` | Sends the "Submit a signing" and "Sign Up" forms |
| `assets/app.js` | Install banner, /app/ page and offline worker registration |
| `assets/app/` | App icons and launch screens |
| `serve.mjs` | Small local web server used by `npm start` |

## Settings

Set as environment variables for the build:

- `BASE_PATH`: the folder the site is served from, such as `/new` (empty at the root of the domain). Set by `SITE_PATH` in `publish.yml`
- `SITE_NOINDEX`: `1` asks search engines not to index the site. Set `SITE_NOINDEX: '0'` in `publish.yml` when the site goes live
- `SUPABASE_URL`, `SUPABASE_KEY`: default to the project's public, read-only values

A signing appears on the site when its status is `published` and its date (or order deadline, if it has no date) is today or later.
