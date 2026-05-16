import type { Library, SeriesEntry } from "../types";
import { coverUrl } from "../library";
import { toggleFavorite } from "../storage";

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

  const favs = new Set(favorites);
  const favSeries = library.series.filter((s) => favs.has(s.id));
  const allSeries = library.series;

  return (
    <div className="shell" data-testid="library-view">
      <div className="shell-header">
        <h1><span className="accent">Net</span>Comix</h1>
        {onOpenAdmin && <AdminBtn onClick={onOpenAdmin} />}
      </div>
      <div className="shell-body">
        {favSeries.length > 0 && (
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
        <div className="section-title">All Series</div>
        {allSeries.length === 0 ? (
          <p style={{ color: "#888" }} data-testid="empty-library">
            No comics yet. Drop a .cbz into <code>comics-source/</code> and push.
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
  return (
    <div className="grid" role="list">
      {items.map((s) => {
        const fav = favorites.has(s.id);
        return (
          <div
            key={s.id}
            className="card"
            role="listitem"
            data-testid={`series-card-${s.id}`}
            onClick={() => onSelectSeries(s)}
          >
            <img
              className="card-cover"
              src={coverUrl(s.path, s.cover, s.coverFileId)}
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
            <div className="card-title">{s.title}</div>
            <div className="card-meta">{s.issueCount} issue{s.issueCount === 1 ? "" : "s"}</div>
          </div>
        );
      })}
    </div>
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
