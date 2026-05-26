# NetComix — Library & Browsing Redesign

**Date:** 2026-05-26  
**Status:** Approved  
**Scope:** LibraryView, SeriesView, storage additions  

---

## Overview

Redesign the library home screen and series view into an editorial, personalised experience. Three sections surface reading state intelligently (hero resume, Favourites strip, In Progress strip) above a clean two-column grid. The series view gains per-issue progress indicators and a star toggle. No new backend or harvester changes required.

---

## Design Decisions

| Question | Decision |
|----------|----------|
| Focus area | Library & browsing (not the reader itself) |
| Visual direction | Editorial — hero + horizontal strips + grid |
| Hero job | Smart resume (last-read series/issue/page + CTA) |
| Sections | Favourites strip → In Progress strip → Library grid |
| Favourites | Yes — star toggle on cards and series header |
| "Your Library" label | "Library" |

---

## Screen 1: Library View

### Layout (top to bottom)

```
┌─────────────────────────────┐
│ NetComix logo      [★] [⚙]  │  ← header
├─────────────────────────────┤
│                             │
│  [HERO — smart resume]      │  ← 130–140px, only when last-read exists
│                             │
├─────────────────────────────┤
│  ★ FAVOURITES               │  ← only when favorites.length > 0
│  [card] [card] [card] →     │  ← horizontal scroll, 66px wide cards
├─────────────────────────────┤
│  IN PROGRESS                │  ← only when in-progress series exist
│  [card] [card] →            │  ← same card style, deduped vs Favourites
├─────────────────────────────┤
│  LIBRARY              ↕     │  ← always visible
│  [card] [card]              │  ← 2-column grid
│  [card] [card]              │
└─────────────────────────────┘
```

### Hero section

- **Condition:** renders only when `getLastRead()` returns a non-null `{seriesId, issueId}`.
- **Fallback:** when nothing has been read yet, hero is omitted entirely; Library grid appears at the top.
- **Content:** blurred series cover as background, series cover image (left), series title + issue number + "pg X of Y" + progress bar (right), red "▶ Continue reading" label.
- **Tap action:** navigates directly to the reader for that issue at the saved position.

### Favourites strip

- **Condition:** renders only when `getFavorites().length > 0`.
- **Cards:** 66 × 90px cover, 2-line wrapping title below, red progress bar.
- **Star icon:** gold star overlay on cover corner.
- **Tap:** navigates to the series view.

### In Progress strip

- **Condition:** renders when at least one series has reading progress > 0% and is not already in the Favourites list.
- **Progress definition:** a series is "in progress" if any issue in its series has a saved `getProgress(issueId)` with `pageIndex > 0`.
- **Dedup rule:** if a series is both favourited and in-progress, it shows only in Favourites.
- **Cards:** same style as Favourites strip.

### Library grid

- **Always visible.** Shows all series from `library.json`.
- **Card anatomy:** 2/3 aspect-ratio cover, issue-count badge (top-right), star toggle button (top-left, filled ★ or empty ☆), 2-line wrapping title, subtitle (vol + issue count), red progress bar.
- **Star toggle:** calls `toggleFavorite(seriesId)` in place, updates Favourites strip reactively.
- **Sort control:** "↕ sort" link in section header (alphabetical ↔ recently-added; v1 can default to alphabetical, sort toggle is optional stretch).

---

## Screen 2: Series View

### Changes from current

- **Star button** in the top-right of the header (replaces unused space). Calls `toggleFavorite(series.id)`, shows filled ★ when favourited.
- **Series-level progress bar** added below the subtitle in the hero banner. Computed as `(issues with any progress) / total issues`.
- **Issue list replaces issue grid.** Each issue row contains:
  - Thumbnail (32 × 46px)
  - Title (wraps to 2 lines, e.g. "Issue #1 — Welcome to the Vault")
  - Subtitle: "X pages" or "X pages · pg Y of Z" when in progress
  - Per-issue progress bar
  - Status badge: `Reading` (red, current issue), `New` (grey, not started)
- **Active issue highlight:** the currently-reading issue row has a subtle red-tinted background and `Reading` badge.

---

## Storage Changes (`src/storage.ts`)

### New: `getLastRead()` / `setLastRead()`

```typescript
const LAST_READ_KEY = "netcomix.lastread.v1";

export interface LastRead {
  seriesId: string;
  issueId: string;
}

export function getLastRead(): LastRead | null {
  try {
    const raw = localStorage.getItem(LAST_READ_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.seriesId && parsed?.issueId) return parsed as LastRead;
    return null;
  } catch { return null; }
}

export function setLastRead(seriesId: string, issueId: string): void {
  localStorage.setItem(LAST_READ_KEY, JSON.stringify({ seriesId, issueId }));
}
```

### Where `setLastRead` is called

`Reader.tsx` — in the existing `useEffect` that calls `setProgress`, add `setLastRead(issue.series, issue.id)` when issue is non-null.

---

## Data Flow

```
localStorage
  netcomix.lastread.v1  ──►  LibraryView hero
  netcomix.favorites.v1 ──►  Favourites strip  (getFavorites — already exists)
  netcomix.progress.*   ──►  In Progress strip + per-issue bars

library.json (fetch)
  series[]              ──►  Library grid

series.json (fetch, on navigation)
  issues[]              ──►  SeriesView issue list
```

---

## Files Touched

| File | Change |
|------|--------|
| `src/storage.ts` | Add `getLastRead`, `setLastRead`, `LastRead` type |
| `src/components/LibraryView.tsx` | Full redesign — hero + strips + grid |
| `src/components/SeriesView.tsx` | Star button, series progress bar, issue rows |
| `src/components/Reader.tsx` | Call `setLastRead` on issue open |
| `src/App.tsx` | Pass `seriesId` down to SeriesView for star toggle (series.id already in route) |
| `src/App.css` / `src/components/LibraryView.css` (new) | New CSS for editorial layout |

`SeriesView.css` may be extracted from `App.css` if the styles grow — keep a single CSS file per component as a soft rule.

---

## Empty / Edge States

| State | Behaviour |
|-------|-----------|
| No comics in library | Library grid shows "No comics yet — upload one to get started" |
| Nothing read yet | Hero section hidden; Library grid at top |
| No favourites | Favourites strip hidden |
| Nothing in progress | In Progress strip hidden |
| Only 1 series | Strips and grid look fine at any count ≥ 1 |
| Series has 1 issue | Issue list shows single row, no awkwardness |

---

## Out of Scope

- Reader visual changes (separate effort)
- Search / filter
- Sort toggle (stretch goal, not required for v1)
- Gemini panel detection improvements
- Uploading / admin flow changes
