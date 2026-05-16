import { useEffect, useState } from "react";
import type { IssueIndexEntry, Library, SeriesEntry, SeriesIndex } from "./types";
import { coverUrl, fetchIssue, fetchLibrary, fetchSeries } from "./library";
import { LibraryView } from "./components/LibraryView";
import { SeriesView } from "./components/SeriesView";
import { Reader } from "./components/Reader";
import { getFavorites } from "./storage";
import "./App.css";

type Route =
  | { name: "library" }
  | { name: "series"; series: SeriesEntry }
  | { name: "reader"; series: SeriesEntry; issue: IssueIndexEntry };

export function App() {
  const [route, setRoute] = useState<Route>({ name: "library" });
  const [library, setLibrary] = useState<Library | null>(null);
  const [seriesIndex, setSeriesIndex] = useState<SeriesIndex | null>(null);
  const [issueData, setIssueData] = useState<Awaited<ReturnType<typeof fetchIssue>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<string[]>([]);

  useEffect(() => {
    setFavorites(getFavorites());
    fetchLibrary()
      .then(setLibrary)
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (route.name === "series") {
      setSeriesIndex(null);
      fetchSeries(route.series.path).then(setSeriesIndex).catch((e) => setError(String(e)));
    }
    if (route.name === "reader") {
      setIssueData(null);
      fetchIssue(route.issue.path).then(setIssueData).catch((e) => setError(String(e)));
    }
  }, [route]);

  if (error) {
    return (
      <div className="empty-state" data-testid="error-state">
        <h1>NetComix</h1>
        <p>Couldn&apos;t load the library.</p>
        <pre>{error}</pre>
        <p className="hint">
          Add comics to <code>comics-source/</code> and push — the harvester action will generate the
          library. For local dev you can drop pre-built manifests in <code>public/comics/</code>.
        </p>
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
        coverUrl={(file) => coverUrl(route.name === "series" ? route.series.path : "", file)}
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
