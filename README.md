# Autograph Hero

The Autograph Hero website. It lists upcoming autograph signings that are stored in the Supabase project "AutographHero Data".

## How it works

1. A scheduled task crawls the source pages every Monday and Friday and saves signings to the `signings` table in Supabase.
2. `build.mjs` reads every signing whose status is `published` and each signer's teams from the `athletes` table, drops the signings that are over, and writes a plain HTML site into `dist/`. Searching a team ("Broncos") finds its players.
3. GitHub Actions (`.github/workflows/publish.yml`) runs that build on every push to `main` and every hour, then uploads `dist/` to Bluehost over FTP.

The upload needs three repository secrets (Settings → Secrets and variables → Actions): `FTP_SERVER`, `FTP_USERNAME` and `FTP_PASSWORD`. Use a Bluehost FTP account whose directory is the site folder (for testing, `public_html/new`), so the upload cannot reach anything else.

## Run it on your computer

You need [Node.js](https://nodejs.org) version 20 or newer. Nothing else to install.

```
npm start
```

This pulls the latest signings from Supabase, builds the site and serves it at http://localhost:3000. Press Ctrl+C to stop. After you change a file, stop it and run `npm start` again.

## Forms

- **Add a listing** (`/add/`) saves to `public.submissions` with status `pending`. Nothing goes live until it is approved: `select admin.approve_submission(<id>)` copies it into `signings` as published (filed under the "Fan submission" source), or `select admin.reject_submission(<id>, 'reason')`. The private approval page does the same with buttons.
- **Get alerts** (`/signup/`) saves name, email and favorites to `public.subscribers` (one row per email; signing up again adds favorites).
- Both go through the Supabase function `site-forms`, which validates, drops bots (hidden field, minimum fill time) and limits each visitor to 5 sends an hour. Both tables are private.

## Where things live

| File | What it is |
| --- | --- |
| `build.mjs` | Fetches the data and holds the page templates (home, all signings, one page per signing) |
| `assets/site.css` | All styling. Colors and fonts are variables at the top |
| `assets/site.js` | The search and filters on the "All signings" page |
| `assets/forms.js` | Sends the "Add a listing" and "Get alerts" forms |
| `serve.mjs` | Small local web server used by `npm start` |

## Settings

Set as environment variables for the build:

- `BASE_PATH`: the folder the site is served from, such as `/new` (empty at the root of the domain). Set by `SITE_PATH` in `publish.yml`
- `SITE_NOINDEX`: `1` asks search engines not to index the site. Set `SITE_NOINDEX: '0'` in `publish.yml` when the site goes live
- `SUPABASE_URL`, `SUPABASE_KEY`: default to the project's public, read-only values

A signing appears on the site when its status is `published` and its date (or order deadline, if it has no date) is today or later.
