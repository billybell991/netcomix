import type { IssueIndexEntry, SeriesEntry, SeriesIndex } from "../types";

interface Props {
  series: SeriesEntry;
  index: SeriesIndex | null;
  onBack: () => void;
  onSelectIssue: (issue: IssueIndexEntry) => void;
  coverUrl: (file: string, fileId?: string) => string;
}

export function SeriesView({ series, index, onBack, onSelectIssue, coverUrl }: Props) {
  return (
    <div className="shell" data-testid="series-view">
      <div className="shell-header">
        <button className="back-btn" data-testid="back-btn" onClick={onBack} aria-label="Back to library">
          ← Library
        </button>
        <h1>{series.title}</h1>
      </div>
      <div className="shell-body">
        {!index ? (
          <p style={{ color: "#888", padding: 8 }}>Loading issues…</p>
        ) : index.issues.length === 0 ? (
          <p style={{ color: "#888" }}>No issues found.</p>
        ) : (
          <div className="grid" role="list">
            {index.issues.map((issue) => (
              <div
                key={issue.id}
                className="card"
                role="listitem"
                data-testid={`issue-card-${issue.id}`}
                onClick={() => onSelectIssue(issue)}
              >
                <img
                  className="card-cover"
                  src={coverUrl(issue.id, issue.cover, issue.coverFileId)}
                  alt={issue.title}
                  loading="lazy"
                />
                <div className="card-title">{issue.title}</div>
                <div className="card-meta">{issue.pageCount} pages</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
