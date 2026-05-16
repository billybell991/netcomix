# NetComix Harvester

Turns `.cbz` / `.cbr` comic archives into the JSON manifests the NetComix reader
consumes (panel coordinates, page sizes, color hints).

## Local usage

```pwsh
cd harvester
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python harvest.py --source ../comics-source --output ../public/comics
```

`.cbr` support requires the system `unrar` binary (e.g. `winget install RARLab.WinRAR`
or `apt install unrar`).

## How it works

For each archive:

1. Extract pages → `public/comics/<series>/<issue>/page-NNN.jpg`
2. Panel detection (OpenCV):
   - grayscale → threshold (configurable via `--gutter`) → close → contours
   - filter contours by size, sort top-to-bottom / left-to-right
3. Compute dominant color for the letterbox background hint
4. Write `issue.json`, `series.json`, and the master `library.json`

## CI

The `.github/workflows/harvest.yml` action runs the harvester whenever you push
new files to `comics-source/`, then commits the regenerated `public/comics/` back
to `main`. The deploy workflow then builds the Vite app and publishes to GitHub
Pages.
