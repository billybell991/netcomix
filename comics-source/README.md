# Drop `.cbz` / `.cbr` files here

When you push to `main`, the **Harvester** GitHub Action will:

1. Extract pages from each archive
2. Detect comic panels with OpenCV
3. Write JSON + JPEG output to `public/comics/`
4. Commit the result back to `main`
5. Trigger the **Deploy** workflow → GitHub Pages

The raw archives themselves are gitignored — only the harvested output ships.

You can also run the harvester locally:

```pwsh
python harvester/harvest.py --source comics-source --output public/comics
```
