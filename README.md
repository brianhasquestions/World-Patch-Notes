# World Patch Notes

The week's most important world events, written like software release notes.
A static site (HTML/CSS/vanilla JS) hosted on GitHub Pages. New weeks are
generated locally by a Claude Code agent and pushed to the repo.

## How it works

```
You (weekly)  ──►  invoke the "patch-notes-writer" agent in Claude Code
                          │
                          ├─ runs  scripts/fetch_news.py   (RSS data/raw/<week>.json)
                          ├─ summarizes into patch notes   (data/weeks/<week>.json)
                          └─ updates the sidebar manifest  (data/index.json)
                          │
You          ──►  git push  ──►  GitHub Pages serves the static site
```

No server, no database, no API keys - just static files and `git push`.

## Project layout

| Path | What it is |
|------|------------|
| `index.html`, `styles.css`, `app.js` | The static site (loads JSON, renders releases) |
| `data/index.json` | Sidebar manifest - list of published weeks |
| `data/weeks/<id>.json` | One release per week (the patch notes) |
| `data/raw/<id>.json` | Fetched headlines (gitignored, intermediate) |
| `scripts/fetch_news.py` | Zero-dependency RSS fetcher |
| `scripts/feeds.txt` | RSS feed list - edit to curate sources |
| `.claude/agents/patch-notes-writer.md` | The weekly writer agent profile |
| `.claude/agents/bias-reviewer.md` | Independent neutrality/bias audit (run after the writer) |
| `.claude/agents/data-refresher.md` | Refreshes the team cards, battlefield and shipping snapshots in `data/` (run weekly) |

## Weekly workflow

1. In Claude Code, generate the draft:
   > Use the **patch-notes-writer** agent to generate this week's release.
2. Run the independent neutrality audit:
   > Use the **bias-reviewer** agent to audit this week's release.

   It flags or fixes loaded language, unattributed claims, one-sidedness, and
   judgmental tags, without touching facts or sources.
3. Refresh the reference data the globe reads:
   > Use the **data-refresher** agent to refresh the team cards and battlefield data.

   It runs the fetch scripts below (team cards, Ukraine battlefield, Iran and
   United States events and shipping), checks the output, and reports; it
   never commits.
4. Preview locally:
   ```
   python -m http.server 8000
   ```
   then open <http://localhost:8000>.
5. When happy, publish:
   ```
   git add data/ && git commit -m "Release vYYYY.WW" && git push
   ```

## Deploying to GitHub Pages (one-time setup)

1. Create a repo and push this project to it.
2. On GitHub: **Settings Pages Build and deployment**.
3. Source: **Deploy from a branch**; Branch: **main**, folder: **/ (root)**.
4. Save. Your site goes live at `https://<user>.github.io/<repo>/`.

Because everything is static and paths are relative, it works under the
`/<repo>/` subpath with no changes.

## Customizing

- **Sources:** edit `scripts/feeds.txt` (one RSS URL per line).
- **Sections / tags / voice:** edit `.claude/agents/patch-notes-writer.md`.
- **Look:** edit `styles.css` (CSS variables at the top control the theme;
  dark mode follows the OS automatically).

## Data format

```jsonc
// data/weeks/2026-W26.json
{
  "id": "2026-W26",
  "title": "Week of Jun 22-28, 2026",
  "version": "v2026.26",
  "released": "2026-06-28",
  "sections": [
    {
      "category": "Geopolitics",
      "changes": [
        { "type": "CHANGE", "text": "…", "sources": ["https://…"], "places": ["FR", "EU"] }
      ]
    }
  ]
}
```

Change types: `NEW`, `CHANGE`, `FIX`, `DEPRECATED`, `ISSUE` (rendered as
"KNOWN ISSUE").

`places` lists where an entry happens, primary place first, using keys from
`data/places.json` (countries, regions, US states, a few named spots like
`US-DC` and `SFBAY`). An empty list means a global story. `guilds` lists the
companies, organizations and bodies an entry names, using keys from
`data/guilds.json`, which also holds each guild's headquarters so the globe
can place it. The keyword rules and patterns in those files drive
`scripts/geotag.js`, which fills in missing `places` and `guilds` for a week
and reports what it could not place:

```bash
node scripts/geotag.js 2026-W43
```

### Reference data snapshots

Two more scripts bring reference data into the repo so the site never calls a
live API. Both cache their downloads in the OS temp folder and accept
`--offline` to rebuild from that cache.

```bash
node scripts/fetch_teams.js
```

writes one small "team card" per country to `data/teams/<KEY>.json` (about 25
fields from the CIA World Factbook: government, leaders, population, economy,
military, disputes, background) via the public domain factbook.json mirror.

```bash
node scripts/fetch_conflict_ua.js
```

writes into `data/conflicts/ua/`:

- `oblasts.json` and `regions_ru_by.json`: Ukraine's regions, plus Belarus and
  European Russia, from Natural Earth (public domain), simplified.
- `strikes.json`: per-day, per-city aerial attack records since 24 Feb 2022
  from the time-machine-data pipeline, Ukrainian-side GeoConfirmed events
  inside Russia and Belarus as `returnFire`, and a list of Russian and
  Belarusian cities. Source and license notes are inside the file.
- `fronts/<date>.json`: weekly front line snapshots from DeepStateMap's public
  history API (occupied, liberated, grey zone, 2014 territories, direction of
  attack), simplified; `fronts/index.json` lists them. About 40 KB per week.

```bash
node scripts/fetch_regions.js
```

writes `data/regions/<KEY>.json`, one file of internal regions (states,
provinces, departments) per country from Natural Earth 10m admin-1, simplified
and sized by country, with each region's ISO code, Wikidata id and computed
area. The globe loads a country's file when its team card opens. It only needs
rerunning when a country is added to `data/places.json`.

```bash
node scripts/fetch_region_facts.js
```

adds a few facts per region from Wikidata (public domain): latest population
with its year, capital, and head of government, matched by the Wikidata id.
Results are cached, so a rerun is quick; the facts survive a rerun of
`fetch_regions.js`.

```bash
node scripts/fetch_conflict_irus.js
```

writes `data/conflicts/irus/events.json` (dated, geolocated placemarks from
GeoConfirmed's Iran and Israel maps since June 2025, with the side
GeoConfirmed assigns and the country each point falls in) and
`shipping.json` (daily vessel transits through the Strait of Hormuz, Bab
el-Mandeb and Suez from IMF PortWatch, with a January to May 2025 baseline).
Pass `--ucdp-token <token>` from a free UCDP account to add UCDP events.

```bash
node scripts/fetch_shipping_hormuz.js
```

writes `data/conflicts/irus/vessels.json` (per-vessel AIS tracks around the
Strait of Hormuz from the Strait of Hormuz Ship Monitor, CC BY 4.0: the ships
in the strait, the ones holding in the Gulf of Oman approaches, and recent
crossers, thinned to one fix per 30 minutes) and `incidents.json` (UKMTO
incident reports with positions, Open Government Licence v3.0). The monitor
only serves the last 500 positions per ship (about two weeks), so the script
merges each run into what is already stored; run it weekly to keep the archive
continuous. `--hf-csv <positions.csv>` merges an AIS CSV export first, and
`--radar-csv <det.csv> <scenes.csv>` rebuilds `radar.json` from radar
detection and scene tables: every vessel-sized Sentinel-1 contact per scene
day, with coastal clutter and fixed structures dropped, matched to the archived
AIS ship nearest at the scene time, and an honest per-scene coverage figure so
the globe never calls a contact "dark" when the archive simply did not follow
that ship.

```bash
node scripts/fetch_hormuz_hf.js --run
```

feeds both of those options from the `yasumorishima/hormuz-ais` dataset on
Hugging Face (AIS positions since March 2026 under aisstream.io's terms, and
Sentinel-1 radar detections, Copernicus data free with attribution). It
downloads only the parquet files that are new since the last run into the OS
temp folder, converts them with a pure JavaScript parquet reader that it
installs there with npm on first use (nothing is added to the repo), and with
`--run` calls `fetch_shipping_hormuz.js` with the resulting CSVs; without
`--run` it prints that command. `--offline` converts what is cached without
touching the network, and `--quick` after `--run` skips the per-ship history
calls.

Options: `--kaggle <missiles_and_uav.csv>` adds launch totals from the Kaggle
missile dataset if you have downloaded it; `--fronts-every 14` halves the
front line cadence; `--no-fronts` skips them. ISW's control-of-terrain layers
were considered and left out because their license requires written consent.
