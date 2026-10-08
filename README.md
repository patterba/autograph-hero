# Autograph Hero

The Autograph Hero website. It lists upcoming autograph signings that are stored in the Supabase project "AutographHero Data".

## How it works

1. A scheduled task crawls the source pages every Monday and Friday and saves signings to the `signings` table in Supabase.
2. `build.mjs` reads every signing whose status is `published`, drops the ones that are over, and writes a plain HTML site into `dist/`.
3. GitHub Actions (`.github/workflows/publish.yml`) runs that build on every push to `main` and once a day, then publishes `dist/` to GitHub Pages.

## Run it on your computer

You need [Node.js](https://nodejs.org) version 20 or newer. Nothing else to install.

```
npm start
```

This pulls the latest signings from Supabase, builds the site and serves it at http://localhost:3000. Press Ctrl+C to stop. After you change a file, stop it and run `npm start` again.

## Where things live

| File | What it is |
| --- | --- |
| `build.mjs` | Fetches the data and holds the page templates (home, all signings, one page per signing) |
| `assets/site.css` | All styling. Colors and fonts are variables at the top |
| `assets/site.js` | The search and filters on the "All signings" page |
| `serve.mjs` | Small local web server used by `npm start` |

## Settings

Set as environment variables for the build:

- `BASE_PATH`: the folder the site is served from (set automatically on GitHub Pages; empty on a custom domain)
- `SITE_NOINDEX`: `1` asks search engines not to index the site. Remove it in `publish.yml` when the site goes live on its real domain
- `SUPABASE_URL`, `SUPABASE_KEY`: default to the project's public, read-only values

A signing appears on the site when its status is `published` and its date (or order deadline, if it has no date) is today or later.
