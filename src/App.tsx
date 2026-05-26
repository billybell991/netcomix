import { useEffect, useState } from "react";
import type { IssueIndexEntry, Library, SeriesEntry, SeriesIndex } from "./types";
import { coverUrl, fetchIssue, fetchLibrary, fetchSeries } from "./library";
import { LibraryView } from "./components/LibraryView";
import { SeriesView } from "./components/SeriesView";
import { Reader } from "./components/Reader";
import { SetupView } from "./components/SetupView";
import { AdminView } from "./components/AdminView";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./App.css";

type Route =
  | { name: "library" }
  | { name: "series"; series: SeriesEntry }
  | { name: "reader"; series: SeriesEntry; issue: IssueIndexEntry }
  | { name: "setup" }
  | { name: "admin" };

export function App() {
  const [route, setRoute] = useState<Route>({ name: "library" });
  const [library, setLibrary] = useState<Library | null>(null);
  const [seriesIndex, setSeriesIndex] = useState<SeriesIndex | null>(null);
  const [issueData, setIssueData] = useState<Awaited<ReturnType<typeof fetchIssue>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setError(null);
    fetchLibrary()
      .then(setLibrary)
      .catch((e) => setError(String(e)));
  }, [reloadKey]);

  useEffect(() => {
    if (route.name === "series") {
      setSeriesIndex(null);
      fetchSeries(route.series.path).then(setSeriesIndex).catch((e) => setError(String(e)));
    }
    if (route.name === "reader") {
      setIssueData(null);
      fetchIssue(route.issue.path, route.issue).then(setIssueData).catch((e) => setError(String(e)));
    }
  }, [route]);

  if (route.name === "setup") {
    return (
      <SetupView
        onSaved={() => { setRoute({ name: "library" }); setReloadKey((k) => k + 1); }}
        onSkip={() => setRoute({ name: "library" })}
      />
    );
  }

  if (route.name === "admin") {
    return (
      <AdminView
        onBack={() => { setRoute({ name: "library" }); setReloadKey((k) => k + 1); }}
        onOpenSetup={() => setRoute({ name: "setup" })}
      />
    );
  }

  if (error) {
    return (
      <div className="empty-state" data-testid="error-state">
        <h1><span className="accent">Net</span>Comix</h1>
        <p>Something went wrong loading the library.</p>
        <pre>{error}</pre>
        <div className="btn-row">
          <button className="btn" onClick={() => setRoute({ name: "setup" })}>Setup</button>
          <button className="btn" onClick={() => setRoute({ name: "admin" })}>Upload</button>
          <button className="btn" onClick={() => { setError(null); setReloadKey((k) => k + 1); }}>Retry</button>
        </div>
      </div>
    );
  }

  if (route.name === "library") {
    return (
      <LibraryView
        library={library}
        onSelectSeries={(s) => setRoute({ name: "series", series: s })}
        onResumeReading={(series, issue) => setRoute({ name: "reader", series, issue })}
        onOpenAdmin={() => setRoute({ name: "admin" })}
      />
    );
  }

  if (route.name === "series") {
    return (
      <SeriesView
        series={route.series}
        index={seriesIndex}
        onBack={() => setRoute({ name: "library" })}
        onSelectIssue={(issue) => setRoute({ name: "reader", series: route.series, issue })}
        coverUrl={(file, fileId, r2Url) => coverUrl("", file, fileId, r2Url)}
      />
    );
  }

  // Only pass issue data when it matches the requested issue — prevents Reader
  // from briefly rendering with a stale previous issue during navigation.
  const validIssue = issueData?.id === route.issue.id ? issueData : null;

  return (
    <ErrorBoundary key={route.issue.id} onReset={() => setRoute({ name: "library" })}>
      <Reader
        key={route.issue.id}
        issue={validIssue}
        issuePath={route.issue.path}
        onBack={() => setRoute({ name: "series", series: route.series })}
      />
    </ErrorBoundary>
  );
}
