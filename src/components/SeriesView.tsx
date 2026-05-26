import type { IssueIndexEntry, SeriesEntry, SeriesIndex } from "../types";

interface Props {
  series: SeriesEntry;
  index: SeriesIndex | null;
  onBack: () => void;
  onSelectIssue: (issue: IssueIndexEntry) => void;
  coverUrl: (file: string, fileId?: string, r2Url?: string) => string;
}

export function SeriesView({ series, index, onBack, onSelectIssue, coverUrl: cvr }: Props) {
  const heroSrc = cvr(series.cover, series.coverFileId, series.coverUrl);

  return (
    <div className="shell" data-testid="series-view">
      {/* Fixed header bar */}
      <div className="shell-header">
        <button className="back-btn" data-testid="back-btn" onClick={onBack}>
          ← Library
        </button>
      </div>

      <div className="shell-body" style={{ padding: "0 0 calc(var(--safe-bottom) + 24px)" }}>
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
                {index ? `${index.issues.length} issue${index.issues.length !== 1 ? "s" : ""}` : "Loading…"}
              </div>
            </div>
          </div>
        </div>

        <div style={{ padding: "0 12px" }}>
          {!index ? (
            <div className="card-grid">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="comic-card skeleton" style={{ aspectRatio: "2/3" }} />
              ))}
            </div>
          ) : index.issues.length === 0 ? (
            <p style={{ color: "var(--text-dim)", fontSize: "0.9rem", padding: 8 }}>No issues found.</p>
          ) : (
            <div className="card-grid" role="list">
              {index.issues.map((issue) => {
                const src = cvr(`${issue.path}/${issue.cover}`, issue.coverFileId, issue.coverUrl);
                return (
                  <div
                    key={issue.id}
                    className="comic-card"
                    role="listitem"
                    data-testid={`issue-card-${issue.id}`}
                    onClick={() => onSelectIssue(issue)}
                  >
                    <img className="comic-card-img" src={src} alt={issue.title} loading="lazy" />
                    <div className="comic-card-overlay">
                      <div className="comic-card-title">{issue.title}</div>
                      <div className="comic-card-meta">{issue.pageCount} pages</div>
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
