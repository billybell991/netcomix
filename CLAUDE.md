# NetComix — Claude Memory

## Stack
- Vite + React 18 + TypeScript PWA, deployed to GitHub Pages at `https://billybell991.github.io/netcomix/`
- Comics served from `/public/comics/` (static JSON manifests + page images)
- Tests: Vitest (run `npm test`); build: `npm run build` (runs `tsc --noEmit` first)
- `noUnusedLocals` and `noUnusedParameters` are both `true` in tsconfig

## After every `git push` — check deployment status

GitHub Pages deploy takes ~1–2 minutes after push. Always run this after pushing:

```powershell
Set-Location "C:\Stuff\NetComix"
gh run list --limit 2 --json status,conclusion,name,url
```

To **wait for the deploy to finish** before declaring it done:

```powershell
Set-Location "C:\Stuff\NetComix"
$runId = (gh run list --limit 1 --json databaseId | ConvertFrom-Json)[0].databaseId
gh run watch $runId --exit-status
Write-Host "✅ Deployed to https://billybell991.github.io/netcomix/"
```

## Rules of Hooks — critical for Reader.tsx

`Reader.tsx` has an early return at `if (!issue || !currentPage)`. **Every hook (`useState`, `useEffect`, `useRef`, `useMemo`, `useCallback`) MUST be declared before this return.** Hooks after the guard cause React error #310 (hook count mismatch between renders).

Current hook order (all before the early return):
1. `useState` × 6 (settings, position, screenSize, hudOpen, debugOverlay, fadeState, stageEl)
2. `useCallback` (stageRefCallback)
3. `useRef` × 3 (swipeRef, pendingNavRef, lastTapRef)
4. `useEffect` × 5 (resize, progress+lastRead, fadeState "in"→"visible", restoreProgress, preCacheNext)
5. `useMemo` (snapTransform)
6. `usePinchZoom` (custom hook)

## Comics data layout
```
public/comics/
  library.json                          ← list of series
  <series-slug>/
    series.json                         ← list of issues
    page-001.jpg                        ← series cover
    <issue-slug>/
      issue.json                        ← page manifests with panel data
      page-001.jpg, page-002.jpg, …
```

## Key gotchas
- `applyZoneGrid` in `library.ts` is exported and tested but **never called** in the app — the harvester provides real panel data. Don't add a call to it unless intentionally replacing panel data.
- `coverUrl(basePath, file, fileId?, r2Url?)` — when calling for SeriesView, pass `""` as basePath and the full relative path as `file`.
- `IssueManifest.series` field = the series ID string (e.g. `"tales-from-the-crypt-v2"`), used by `setLastRead`.
- Dev toolbar (`🔲`) is gated behind `import.meta.env.DEV` — won't appear in production builds.
