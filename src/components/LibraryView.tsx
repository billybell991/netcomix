import { useState } from "react";
import type { Library, SeriesEntry } from "../types";
import { coverUrl } from "../library";
import { toggleFavorite } from "../storage";
import { CardPreview } from "./CardPreview";
import type { PreviewItem } from "./CardPreview";

interface Props {
  library: Library | null;
  favorites: string[];
  onSelectSeries: (s: SeriesEntry) => void;
  onFavoritesChanged: (favs: string[]) => void;
  onOpenAdmin?: () => void;
}

export function LibraryView({ library, favorites, onSelectSeries, onFavoritesChanged, onOpenAdmin }: Props) {
  if (!library) {
    return (
      <div className="shell" data-testid="library-loading">
        <div className="shell-header">
          <h1><span className="accent">Net</span>Comix</h1>
          {onOpenAdmin && <AdminBtn onClick={onOpenAdmin} />}
        </div>
        <div className="shell-body">
          <p style={{ color: "#888", padding: 8 }}>Loading library…</p>
        </div>
      </div>
    );
  }

  const [query, setQuery] = useState("");

  const favs = new Set(favorites);
  const q = query.trim().toLowerCase();

  const sortKey = (title: string) =>
    title.replace(/^(the|a|an)\s+/i, "").trimStart();

  const sorted = [...library.series].sort((a, b) =>
    sortKey(a.title).localeCompare(sortKey(b.title))
  );
  const favSeries = sorted.filter((s) => favs.has(s.id));
  const allSeries = q
    ? sorted.filter((s) => s.title.toLowerCase().includes(q))
    : sorted;

  return (
    <div className="shell" data-testid="library-view">
      <div className="shell-header">
        <h1><span className="accent">Net</span>Comix</h1>
        {onOpenAdmin && <AdminBtn onClick={onOpenAdmin} />}
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
        {!q && favSeries.length > 0 && (
          <>
            <div className="section-title">Favorites</div>
            <Grid
              items={favSeries}
              favorites={favs}
              onSelectSeries={onSelectSeries}
              onFavoritesChanged={onFavoritesChanged}
            />
          </>
        )}
        <div className="section-title">{q ? "Results" : "All Series"}</div>
        {allSeries.length === 0 ? (
          <p style={{ color: "#888" }} data-testid="empty-library">
            {q ? `No series matching "${query}".` : "No comics yet. Drop a .cbz/.cbr into your Drive folder, then tap ⚙ → Scan."}
          </p>
        ) : (
          <Grid
            items={allSeries}
            favorites={favs}
            onSelectSeries={onSelectSeries}
            onFavoritesChanged={onFavoritesChanged}
          />
        )}
      </div>
    </div>
  );
}

function Grid({
  items,
  favorites,
  onSelectSeries,
  onFavoritesChanged,
}: {
  items: SeriesEntry[];
  favorites: Set<string>;
  onSelectSeries: (s: SeriesEntry) => void;
  onFavoritesChanged: (favs: string[]) => void;
}) {
  const [preview, setPreview] = useState<SeriesEntry | null>(null);

  const previewItem: PreviewItem | null = preview
    ? {
        title: preview.title,
        coverSrc: coverUrl(preview.path, preview.cover, preview.coverFileId, preview.coverUrl),
        meta: `${preview.issueCount} issue${preview.issueCount === 1 ? "" : "s"}`,
        wikiQuery: preview.title,
      }
    : null;

  return (
    <>
      <div className="grid" role="list">
        {items.map((s) => {
          const fav = favorites.has(s.id);
          return (
            <div
              key={s.id}
              className="card"
              role="listitem"
              data-testid={`series-card-${s.id}`}
              onClick={() => setPreview(s)}
            >
              <img
                className="card-cover"
                src={coverUrl(s.path, s.cover, s.coverFileId, s.coverUrl)}
                alt={s.title}
                loading="lazy"
              />
              <button
                className={`card-fav ${fav ? "on" : ""}`}
                aria-label={fav ? "Unfavorite" : "Favorite"}
                onClick={(e) => {
                  e.stopPropagation();
                  const next = toggleFavorite(s.id);
                  onFavoritesChanged(next);
                }}
              >
                {fav ? "★" : "☆"}
              </button>
              <div className="card-title" title={s.title}>{s.title}</div>
              <div className="card-meta">{s.issueCount} issue{s.issueCount === 1 ? "" : "s"}</div>
            </div>
          );
        })}
      </div>
      <CardPreview
        item={previewItem}
        onOpen={() => { onSelectSeries(preview!); setPreview(null); }}
        onClose={() => setPreview(null)}
      />
    </>
  );
}

function AdminBtn({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="back-btn"
      onClick={onClick}
      data-testid="admin-btn"
      aria-label="Admin"
      style={{ marginLeft: "auto" }}
    >
      ⚙
    </button>
  );
}
