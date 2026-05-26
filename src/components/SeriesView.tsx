import { useState } from "react";
import type { IssueIndexEntry, SeriesEntry, SeriesIndex } from "../types";
import { getLastRead, getProgress, isFavorite, toggleFavorite } from "../storage";
import "./SeriesView.css";

interface Props {
  series: SeriesEntry;
  index: SeriesIndex | null;
  onBack: () => void;
  onSelectIssue: (issue: IssueIndexEntry) => void;
  coverUrl: (file: string, fileId?: string, r2Url?: string) => string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Issue progress as a 0-100 integer percentage. */
function issueProgressPct(issueId: string, pageCount: number): number {
  if (pageCount <= 1) return 0;
  const prog = getProgress(issueId);
  if (!prog) return 0;
  const pageIndex = parseInt(prog.split(":")[0], 10);
  if (isNaN(pageIndex) || pageIndex <= 0) return 0;
  return Math.round(Math.min(pageIndex / (pageCount - 1), 1) * 100);
}

/** Series progress as a 0-100 integer percentage (fraction of issues started). */
function seriesProgressPct(issues: IssueIndexEntry[]): number {
  if (issues.length === 0) return 0;
  const started = issues.filter((iss) => {
    const prog = getProgress(iss.id);
    if (!prog) return false;
    return parseInt(prog.split(":")[0], 10) > 0;
  }).length;
  return Math.round((started / issues.length) * 100);
}

// ─── Component ──────────────────────────────────────────────────────────────

export function SeriesView({ series, index, onBack, onSelectIssue, coverUrl: cvr }: Props) {
  const [isFav, setIsFav] = useState(() => isFavorite(series.id));

  const heroSrc = cvr(`${series.path}/${series.cover}`, series.coverFileId, series.coverUrl);
  const lastReadIssueId = getLastRead()?.issueId ?? null;
  const seriesPct = index ? seriesProgressPct(index.issues) : 0;

  const handleToggleFav = () => {
    toggleFavorite(series.id);
    setIsFav((v) => !v);
  };

  return (
    <div className="shell" data-testid="series-view">
      {/* Header */}
      <div className="shell-header">
        <button className="back-btn" data-testid="back-btn" onClick={onBack}>
          ← Library
        </button>
        <button
          className={`ser-star-btn${isFav ? " on" : ""}`}
          aria-label={isFav ? "Remove from favourites" : "Add to favourites"}
          data-testid="series-fav-btn"
          onClick={handleToggleFav}
        >
          {isFav ? "★" : "☆"}
        </button>
      </div>

      <div className="shell-body" style={{ padding: "0 0 0" }}>
        {/* Hero banner */}
        <div className="series-hero">
          <div
            className="series-hero-bg"
            style={{ backgroundImage: `url(${heroSrc})` }}
          />
          <div className="series-hero-content">
            <img className="series-hero-cover" src={heroSrc} alt={series.title} />
            <div className="series-hero-text">
              <div className="series-hero-title">{series.title}</div>
              <div className="series-hero-meta">
                {index
                  ? `${index.issues.length} issue${index.issues.length !== 1 ? "s" : ""}`
                  : "Loading…"}
              </div>
              {seriesPct > 0 && (
                <div className="ser-hero-prog">
                  <div className="ser-hero-prog-fill" style={{ width: `${seriesPct}%` }} />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Issue list */}
        {!index ? (
          <IssueListSkeleton />
        ) : index.issues.length === 0 ? (
          <p style={{ color: "var(--text-dim)", fontSize: "0.9rem", padding: "16px 12px" }}>
            No issues found.
          </p>
        ) : (
          <div className="issue-list" role="list">
            {index.issues.map((issue) => {
              const thumbSrc = cvr(
                `${issue.path}/${issue.cover}`,
                issue.coverFileId,
                issue.coverUrl
              );
              const pct = issueProgressPct(issue.id, issue.pageCount);
              const isActive = issue.id === lastReadIssueId;

              let metaText = `${issue.pageCount} pages`;
              if (pct > 0) {
                const prog = getProgress(issue.id);
                const pageIndex = prog ? parseInt(prog.split(":")[0], 10) : 0;
                metaText = `${issue.pageCount} pages · pg ${pageIndex + 1}`;
              }

              return (
                <div
                  key={issue.id}
                  className={`issue-row${isActive ? " issue-row--active" : ""}`}
                  role="listitem"
                  data-testid={`issue-card-${issue.id}`}
                  onClick={() => onSelectIssue(issue)}
                >
                  <div className="issue-thumb">
                    <img src={thumbSrc} alt={issue.title} loading="lazy" />
                  </div>
                  <div className="issue-info">
                    <div className="issue-title">{issue.title}</div>
                    <div className="issue-meta">{metaText}</div>
                    <div className="issue-prog">
                      <div className="issue-prog-fill" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                  {isActive ? (
                    <span className="issue-badge issue-badge--reading">Reading</span>
                  ) : (
                    <span className="issue-badge issue-badge--new">New</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function IssueListSkeleton() {
  return (
    <div className="issue-list">
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="issue-row skeleton"
          style={{ height: 64 }}
        />
      ))}
    </div>
  );
}
