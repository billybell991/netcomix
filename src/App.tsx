import { useEffect, useState } from "react";
import type { IssueIndexEntry, Library, SeriesEntry, SeriesIndex } from "./types";
import { coverUrl, fetchIssue, fetchLibrary, fetchSeries } from "./library";
import { LibraryView } from "./components/LibraryView";
import { SeriesView } from "./components/SeriesView";
import { Reader } from "./components/Reader";
import { SetupView } from "./components/SetupView";
import { AdminView } from "./components/AdminView";
import { getFavorites } from "./storage";
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
  const [favorites, setFavorites] = useState<string[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setFavorites(getFavorites());
    setError(null);
    fetchLibrary()
      .then(setLibrary)
      .catch((e) => setError(String(e)));
  }, [reloadKey]);

  useEffect(() => {
    if (route.name === "series") {
      setSeriesIndex(null);
      fetchSeries(route.series.path, route.series).then(setSeriesIndex).catch((e) => setError(String(e)));
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
        onBack={() => setRoute({ name: "library" })}
        onOpenSetup={() => setRoute({ name: "setup" })}
      />
    );
  }

  if (error) {
    return (
      <div className="empty-state" data-testid="error-state">
        <h1>NetComix</h1>
        <p>Couldn&apos;t load the library.</p>
        <pre>{error}</pre>
        <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 12, flexWrap: "wrap" }}>
          <button className="back-btn" onClick={() => setRoute({ name: "setup" })} data-testid="goto-setup">
            Open Setup
          </button>
          <button className="back-btn" onClick={() => setRoute({ name: "admin" })} data-testid="goto-admin">
            Open Admin
          </button>
          <button className="back-btn" onClick={() => { setError(null); setReloadKey((k) => k + 1); }}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (route.name === "library") {
    return (
      <LibraryView
        library={library}
        favorites={favorites}
        onSelectSeries={(s) => setRoute({ name: "series", series: s })}
        onFavoritesChanged={setFavorites}
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
        coverUrl={(file, fileId) => coverUrl(route.name === "series" ? route.series.path : "", file, fileId)}
      />
    );
  }

  return (
    <Reader
      issue={issueData}
      issuePath={route.issue.path}
      onBack={() => setRoute({ name: "series", series: route.series })}
    />
  );
}
