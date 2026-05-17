# NetComix

> Cinematic comic reader with smart panel snapping. Built as a PWA, hosted on GitHub Pages, with a Python harvester that runs as a GitHub Action.

## What it is

A "Netflix-for-comics" reader that auto-detects the panels in each page and **center-snaps** them in front of your eyes — so you barely have to move while reading. Built for phones, but works anywhere.

### Reader features
- **Snap loop**: full page → first panel → next panel → … → next page full
- **Focal-point math**: every panel's center lands dead-center on your screen
- **Pinch-to-zoom override**: zoom in anywhere; next tap re-centers, second tap advances
- **Ghost HUD**: configurable transparency, corner-vs-side hit-zone layout
- **Center-tap or long-press** to summon the HUD (configurable)
- **Color-matched letterbox**: empty bars blend with the page's dominant color
- **Sounds + haptics**: page-turn whoosh and panel tick
- **Library / Series / Issues**: Netflix-style browse, favorites, reading progress
- **PWA**: install to home screen, offline-cached pages

## Quick start

```pwsh
npm install
npm run dev         # → http://localhost:5173/netcomix/
```

## Tests (Vitest + Playwright)

```pwsh
npm test                       # unit
npm run test:e2e               # headless Playwright
npm run test:e2e:visual        # headed visual journey (watch it!)
npm run test:e2e:regression    # pixel-perfect baselines
npm run test:qa                # all of the above
```

## Adding comics

1. Drop `.cbz` / `.cbr` files into `comics-source/` and push to `main`.
2. The **Harvest** GitHub Action extracts the pages, detects panels with OpenCV, writes `public/comics/`, commits, and pushes.
3. The **Deploy** workflow rebuilds the PWA and publishes to GitHub Pages.

Or run locally:

```pwsh
cd harvester
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python harvest.py --source ../comics-source --output ../public/comics
```

## Architecture

| Layer | Stack |
|---|---|
| Frontend | React 18 + TypeScript + Vite + vite-plugin-pwa |
| Hosting | GitHub Pages (project pages, base `/netcomix/`) |
| Source storage | `comics-source/` (gitignored — raw archives never committed) |
| Output storage | `public/comics/` (committed JSON + page images) |
| Panel detection | Python + OpenCV (`harvester/harvest.py`) |
| CI | GitHub Actions: `harvest.yml`, `deploy.yml`, `tests.yml` |

## To-do

- **Local comic upload (Settings)** — Add a file-picker to the Settings view that accepts one or more `.cbz`/`.cbr` files from the local drive, runs the harvester pipeline (`harvest_local.py`) against only those files, writes the resulting JSON + page images into `public/comics/`, and refreshes the library without a full re-harvest. Should handle batch uploads (multiple files selected at once).

- **Next/Prev button size (Settings)** — Add a button-size preference (Small / Medium / Large) to the Settings view. The chosen size scales the hit-zone and visual size of the Next and Prev buttons while keeping the user's existing layout-position setting (corners, sides, etc.) unchanged.

- **Library alphabetical sort** — Sort series on the main Library page alphabetically by title so comics are easy to find as the collection grows.

- **Library search bar** — Add a dynamic/live search bar to the Library page that filters series by title as the user types, with no submit button needed.

- **Settings GitHub error** — Investigate and fix the lingering GitHub API error that still appears in the Settings view. Identify the root cause (bad token, wrong repo path, missing permission, stale config, etc.) and surface a clear error message or resolution hint to the user instead of a raw error.

- **Scan button feedback** — Make the Scan button in Settings actually reflect what's happening: show a spinner or progress indicator while the GitHub Action is queued/running, and display a clear success or failure result when it finishes. Ideally surface per-file or percentage progress if the API supports it.

## License

Personal project. No license granted.
