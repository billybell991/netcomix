import { useEffect, useState } from "react";
import type { IssueIndexEntry, Library, SeriesEntry } from "../types";
import { coverUrl, fetchSeries } from "../library";
import {
  getFavorites, getInProgressSeriesIds, getLastRead, getProgress,
  getSeriesStartedFraction, toggleFavorite, type LastRead,
} from "../storage";
import "./LibraryView.css";

interface HeroData {
  series: SeriesEntry;
  issue: IssueIndexEntry;
  /** pageIndex from stored progress — used for the progress bar */
  pageIndex: number;
}

interface Props {
  library: Library | null;
  onSelectSeries: (s: SeriesEntry) => void;
  onResumeReading: (series: SeriesEntry, issue: IssueIndexEntry) => void;
  onOpenAdmin?: () => void;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function LibraryView({ library, onSelectSeries, onResumeReading, onOpenAdmin }: Props) {
  const [favorites, setFavorites] = useState<string[]>(() => getFavorites());
  const [heroData, setHeroData] = useState<HeroData | null>(null);

  // Load hero data: fetch series.json for the last-read series so we can show
  // issue title and page count in the banner.
  useEffect(() => {
    if (!library) return;
    const lastRead: LastRead | null = getLastRead();
    if (!lastRead) { setHeroData(null); return; }

    const series = library.series.find((s) => s.id === lastRead.seriesId);
    if (!series) { setHeroData(null); return; }

    fetchSeries(series.path)
      .then((idx) => {
        const issue = idx.issues.find((i) => i.id === lastRead.issueId);
        if (!issue) return;
        const prog = getProgress(issue.id);
        const pageIndex = prog ? (parseInt(prog.split(":")[0], 10) || 0) : 0;
        setHeroData({ series, issue, pageIndex });
      })
      .catch(() => setHeroData(null)); // fail silently — hero is optional
  }, [library]);

  if (!library) return <LibrarySkeleton />;

  const favSet = new Set(favorites);
  const allIds = library.series.map((s) => s.id);
  const inProgressIds = new Set(getInProgressSeriesIds(allIds));

  const favoriteSeries = library.series.filter((s) => favSet.has(s.id));
  // In-progress strip: in-progress but NOT also a favourite (deduped)
  const inProgressSeries = library.series.filter(
    (s) => inProgressIds.has(s.id) && !favSet.has(s.id)
  );

  const handleToggleFav = (e: React.MouseEvent, seriesId: string) => {
    e.stopPropagation();
    setFavorites(toggleFavorite(seriesId));
  };

  return (
    <div className="shell" data-testid="library-view">
      {/* Header */}
      <div className="shell-header">
        <div className="app-logo"><span className="accent">NET</span>COMIX</div>
        {onOpenAdmin && (
          <button
            className="icon-btn"
            onClick={onOpenAdmin}
            aria-label="Upload comics"
            data-testid="admin-btn"
          >
            ＋
          </button>
        )}
      </div>

      <div className="shell-body" style={{ padding: 0 }}>
        {/* ── Hero ── */}
        {heroData && (
          <HeroBanner
            heroData={heroData}
            onClick={() => onResumeReading(heroData.series, heroData.issue)}
          />
        )}

        {/* ── Favourites strip ── */}
        {favoriteSeries.length > 0 && (
          <div className="lib-section">
            <div className="lib-section-header">
              <span className="lib-section-title">★ Favourites</span>
            </div>
            <div className="lib-strip" role="list">
              {favoriteSeries.map((s) => (
                <StripCard
                  key={s.id}
                  series={s}
                  showStar
                  onClick={() => onSelectSeries(s)}
                />
              ))}
            </div>
          </div>
        )}

        {/* ── In Progress strip ── */}
        {inProgressSeries.length > 0 && (
          <div className="lib-section">
            <div className="lib-section-header">
              <span className="lib-section-title">In Progress</span>
            </div>
            <div className="lib-strip" role="list">
              {inProgressSeries.map((s) => (
                <StripCard
                  key={s.id}
                  series={s}
                  showStar={false}
                  onClick={() => onSelectSeries(s)}
                />
              ))}
            </div>
          </div>
        )}

        {/* ── Library grid ── */}
        <div className="lib-grid-section">
          <div className="lib-section-header">
            <span className="lib-section-title">Library</span>
          </div>
          {library.series.length === 0 ? (
            <p
              style={{ color: "var(--text-dim)", fontSize: "0.9rem", padding: "8px 2px" }}
              data-testid="empty-library"
            >
              No comics yet — tap ＋ to upload your first comic.
            </p>
          ) : (
            <div className="lib-grid" role="list">
              {library.series.map((s) => {
                const fav = favSet.has(s.id);
                const src = coverUrl(s.path, s.cover, s.coverFileId, s.coverUrl);
                return (
                  <div
                    key={s.id}
                    className="lib-grid-card"
                    role="listitem"
                    data-testid={`series-card-${s.id}`}
                    onClick={() => onSelectSeries(s)}
                  >
                    <div className="lib-grid-cover">
                      <img src={src} alt={s.title} loading="lazy" />
                      <span className="lib-grid-badge">{s.issueCount} iss</span>
                      <button
                        className={`lib-grid-star${fav ? " on" : ""}`}
                        aria-label={fav ? "Remove from favourites" : "Add to favourites"}
                        onClick={(e) => handleToggleFav(e, s.id)}
                      >
                        {fav ? "★" : "☆"}
                      </button>
                    </div>
                    <div className="lib-grid-info">
                      <div className="lib-grid-name">{s.title}</div>
                      <div className="lib-grid-meta">
                        {s.issueCount} issue{s.issueCount !== 1 ? "s" : ""}
                      </div>
                      <div className="lib-grid-prog">
                        <div
                          className="lib-grid-prog-fill"
                          style={{ width: `${Math.round(getSeriesStartedFraction(s.id, s.issueCount) * 100)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function HeroBanner({ heroData, onClick }: { heroData: HeroData; onClick: () => void }) {
  const { series, issue, pageIndex } = heroData;
  const src = coverUrl(series.path, series.cover, series.coverFileId, series.coverUrl);
  const pct = issue.pageCount > 1
    ? Math.round(Math.min(pageIndex / (issue.pageCount - 1), 1) * 100)
    : 0;

  return (
    <div
      className="lib-hero"
      role="button"
      aria-label={`Continue reading ${series.title}`}
      onClick={onClick}
    >
      <div className="lib-hero-bg" style={{ backgroundImage: `url(${src})` }} />
      <div className="lib-hero-gradient" />
      <div className="lib-hero-bottom" />
      <img className="lib-hero-cover" src={src} alt={series.title} />
      <div className="lib-hero-info">
        <div className="lib-hero-eyebrow">▶ Continue reading</div>
        <div className="lib-hero-title">{series.title}</div>
        <div className="lib-hero-meta">
          {issue.title} · pg {pageIndex + 1} of {issue.pageCount}
        </div>
        <div className="lib-hero-bar">
          <div className="lib-hero-bar-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}

function StripCard({
  series, showStar, onClick,
}: {
  series: SeriesEntry;
  showStar: boolean;
  onClick: () => void;
}) {
  const src = coverUrl(series.path, series.cover, series.coverFileId, series.coverUrl);
  const progPct = Math.round(getSeriesStartedFraction(series.id, series.issueCount) * 100);
  return (
    <div className="lib-strip-card" role="listitem" onClick={onClick}>
      <div className="lib-strip-cover">
        <img src={src} alt={series.title} loading="lazy" />
        {showStar && <span className="lib-strip-star">★</span>}
      </div>
      <div className="lib-strip-prog">
        <div className="lib-strip-prog-fill" style={{ width: `${progPct}%` }} />
      </div>
      <div className="lib-strip-name">{series.title}</div>
    </div>
  );
}

function LibrarySkeleton() {
  return (
    <div className="shell" data-testid="library-view">
      <div className="shell-header">
        <div className="app-logo"><span className="accent">NET</span>COMIX</div>
      </div>
      <div className="shell-body" style={{ padding: 0 }}>
        <div className="lib-grid-section">
          <div className="lib-section-header">
            <span className="lib-section-title">Library</span>
          </div>
          <div className="lib-grid">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="lib-grid-card skeleton" style={{ aspectRatio: "2/3" }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
