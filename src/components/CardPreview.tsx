import { useEffect, useState } from "react";

export interface PreviewItem {
  title: string;
  coverSrc: string;
  meta: string;
  /** Query sent to Wikipedia for flavor text — usually the series title */
  wikiQuery: string;
}

async function fetchWikiSummary(query: string): Promise<string | null> {
  try {
    // Try direct title match first
    const slug = encodeURIComponent(query.trim().replace(/\s+/g, "_"));
    const directRes = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`
    );
    if (directRes.ok) {
      const data = await directRes.json();
      if (data.type !== "disambiguation" && data.extract) return data.extract as string;
    }

    // Fall back to search
    const searchRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query + " comic")}&format=json&origin=*&srlimit=1`
    );
    if (searchRes.ok) {
      const searchData = await searchRes.json();
      const hit = searchData?.query?.search?.[0];
      if (hit) {
        const sumRes = await fetch(
          `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent((hit.title as string).replace(/\s+/g, "_"))}`
        );
        if (sumRes.ok) {
          const sumData = await sumRes.json();
          return (sumData.extract as string) ?? null;
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
