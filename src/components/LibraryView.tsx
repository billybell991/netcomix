import { useState } from "react";
import type { Library, SeriesEntry } from "../types";
import { coverUrl } from "../library";
import { toggleFavorite, getFavorites } from "../storage";

interface Props {
  library: Library | null;
  onSelectSeries: (s: SeriesEntry) => void;
  onOpenAdmin?: () => void;
}

export function LibraryView({ library, onSelectSeries, onOpenAdmin }: Props) {
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState<string[]>(() => getFavorites());

  const favSet = new Set(favorites);

  const sortKey = (t: string) => t.replace(/^(the|a|an)\s+/i, "").trimStart();

  const sorted = library
    ? [...library.series].sort((a, b) => sortKey(a.title).localeCompare(sortKey(b.title)))
    : [];

  const q = query.trim().toLowerCase();
  const filtered = q ? sorted.filter((s) => s.title.toLowerCase().includes(q)) : sorted;
  const favSeries = !q ? filtered.filter((s) => favSet.has(s.id)) : [];
  const allSeries = !q ? filtered.filter((s) => !favSet.has(s.id)) : filtered;

  return (
    <div className="shell" data-testid="library-view">
      <div className="shell-header">
        <div className="app-logo"><span className="accent">NET</span>COMIX</div>
        {onOpenAdmin && (
          <button className="icon-btn" onClick={onOpenAdmin} aria-label="Upload comics" data-testid="admin-btn">
            ＋
          </button>
        )}
      </div>

      <div className="shell-body">
        <input
          className="search-bar"
          type="search"
          placeholder="Search series…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="search-input"
        />

        {!library ? (
          <SkeletonGrid />
        ) : filtered.length === 0 ? (
          <p style={{ color: "var(--text-dim)", fontSize: "0.9rem", padding: "8px 2px" }} data-testid="empty-library">
            {q ? `No results for "${query}"` : "No comics yet — tap ＋ to upload your first comic."}
          </p>
        ) : (
          <>
            {favSeries.length > 0 && (
              <>
                <div className="section-label">Favourites</div>
                <SeriesGrid
                  items={favSeries}
                  favSet={favSet}
                  onSelect={onSelectSeries}
                  onToggleFav={(id) => setFavorites(toggleFavorite(id))}
                />
              </>
            )}
            {allSeries.length > 0 && (
              <>
                {favSeries.length > 0 && <div className="section-label" style={{ marginTop: 8 }}>All Series</div>}
                <SeriesGrid
                  items={allSeries}
                  favSet={favSet}
                  onSelect={onSelectSeries}
                  onToggleFav={(id) => setFavorites(toggleFavorite(id))}
                />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SeriesGrid({
  items, favSet, onSelect, onToggleFav,
}: {
  items: SeriesEntry[];
  favSet: Set<string>;
  onSelect: (s: SeriesEntry) => void;
  onToggleFav: (id: string) => void;
}) {
  return (
    <div className="card-grid">
      {items.map((s) => {
        const src = coverUrl(s.path, s.cover, s.coverFileId, s.coverUrl);
        const isFav = favSet.has(s.id);
        return (
          <div
            key={s.id}
            className="comic-card"
            data-testid={`series-card-${s.id}`}
            onClick={() => onSelect(s)}
          >
            <img className="comic-card-img" src={src} alt={s.title} loading="lazy" />
            <div className="comic-card-overlay">
              <div className="comic-card-title">{s.title}</div>
              <div className="comic-card-meta">{s.issueCount} issue{s.issueCount !== 1 ? "s" : ""}</div>
            </div>
            <button
              className={`comic-card-fav ${isFav ? "on" : ""}`}
              aria-label={isFav ? "Unfavourite" : "Favourite"}
              onClick={(e) => { e.stopPropagation(); onToggleFav(s.id); }}
            >
              {isFav ? "★" : "☆"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="card-grid">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="comic-card skeleton" style={{ aspectRatio: "2/3" }} />
      ))}
    </div>
  );
}
