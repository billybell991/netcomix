import { useEffect, useState } from "react";

export interface PreviewItem {
  title: string;
  coverSrc: string;
  meta: string;
  /** Query sent to Wikipedia for flavor text — usually the series title */
  wikiQuery: string;
}

/** Returns fraction of significant (>3 char) query words found in the article title. */
function titleRelevance(query: string, articleTitle: string): number {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  if (words.length === 0) return 0;
  const title = articleTitle.toLowerCase();
  return words.filter((w) => title.includes(w)).length / words.length;
}

async function fetchWikiSummary(query: string): Promise<string | null> {
  const MIN_RELEVANCE = 0.5;
  try {
    // Try direct title match first
    const slug = encodeURIComponent(query.trim().replace(/\s+/g, "_"));
    const directRes = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`
    );
    if (directRes.ok) {
      const data = await directRes.json();
      if (
        data.type !== "disambiguation" &&
        data.extract &&
        titleRelevance(query, data.title as string) >= MIN_RELEVANCE
      ) {
        return data.extract as string;
      }
    }

    // Fall back to search — fetch top 3 and pick the most relevant
    const searchRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query + " comic book")}&format=json&origin=*&srlimit=3`
    );
    if (searchRes.ok) {
      const searchData = await searchRes.json();
      const hits: { title: string }[] = searchData?.query?.search ?? [];
      for (const hit of hits) {
        if (titleRelevance(query, hit.title) < MIN_RELEVANCE) continue;
        const sumRes = await fetch(
          `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hit.title.replace(/\s+/g, "_"))}`
        );
        if (sumRes.ok) {
          const sumData = await sumRes.json();
          if (sumData.extract) return sumData.extract as string;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

interface Props {
  item: PreviewItem | null;
  onOpen: () => void;
  onClose: () => void;
}

export function CardPreview({ item, onOpen, onClose }: Props) {
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!item) {
      setSummary(null);
      return;
    }
    setLoading(true);
    setSummary(null);
    fetchWikiSummary(item.wikiQuery).then((text) => {
      setSummary(text);
      setLoading(false);
    });
  }, [item]);

  if (!item) return null;

  return (
    <>
      <div className="preview-backdrop" onClick={onClose} />
      <div className="preview-sheet" onClick={onClose} role="dialog" aria-modal="true" aria-label={item.title}>
        <div className="preview-drag-handle" />
        <div className="preview-inner" onClick={(e) => e.stopPropagation()}>
          <div className="preview-top">
            <img className="preview-cover" src={item.coverSrc} alt={item.title} />
            <div className="preview-info">
              <div className="preview-title">{item.title}</div>
              <div className="preview-meta">{item.meta}</div>
              <button
                className="preview-open-btn"
                onClick={(e) => { e.stopPropagation(); onOpen(); }}
              >
                Read →
              </button>
            </div>
          </div>
          {loading && <p className="preview-blurb preview-blurb--loading">Looking up info…</p>}
          {!loading && summary && <p className="preview-blurb">{summary}</p>}
        </div>
      </div>
    </>
  );
}
