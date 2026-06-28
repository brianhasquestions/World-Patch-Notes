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

## Weekly workflow

1. In Claude Code, generate the draft:
   > Use the **patch-notes-writer** agent to generate this week's release.
2. Run the independent neutrality audit:
   > Use the **bias-reviewer** agent to audit this week's release.

   It flags or fixes loaded language, unattributed claims, one-sidedness, and
   judgmental tags, without touching facts or sources.
3. Preview locally:
   ```
   python -m http.server 8000
   ```
   then open <http://localhost:8000>.
4. When happy, publish:
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
        { "type": "CHANGE", "text": "…", "sources": ["https://…"] }
      ]
    }
  ]
}
```

Change types: `NEW`, `CHANGE`, `FIX`, `DEPRECATED`, `ISSUE` (rendered as
"KNOWN ISSUE").
