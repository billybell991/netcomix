import { useEffect, useState } from "react";

const CV_KEY = "5e7b65578da0df8113f9e2c75daf6ec8705fcb7b";

export interface PreviewItem {
  title: string;
  coverSrc: string;
  meta: string;
  /** Wikipedia search query — used for series cards */
  wikiQuery: string;
  /** When set, Comic Vine is tried first via JSONP (bypasses CORS) */
  seriesTitle?: string;
}

function titleRelevance(query: string, articleTitle: string): number {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  if (words.length === 0) return 0;
  const title = articleTitle.toLowerCase();
  return words.filter((w) => title.includes(w)).length / words.length;
}

/** Strip version tags, years, publisher tags so searches hit the right article.
 *  "Tales from the Crypt v2" → "Tales from the Crypt"
 *  "Steam Wars - Bounty Hunters" → "Steam Wars Bounty Hunters"
 */
function cleanSearchQuery(raw: string): string {
  return raw
    .replace(/\bvol\.?\s*\d+\b/gi, "")   // vol 2 / vol. 2
    .replace(/\bv\d+\b/gi, "")            // v2 / v3
    .replace(/\(\d{4}\)/g, "")            // (2007)
    .replace(/\[[^\]]*\]/g, "")           // [Papercutz]
    .replace(/[-–—]+/g, " ")             // hyphens/dashes → space
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(html: string): string {
  return (html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// JSONP helper — injects a <script> tag, bypassing CORS
interface JsonpResult {
  status_code: number;
  results: Array<{
    name: string | null;
    deck: string | null;
    description: string | null;
    count_of_issues: number;
  }>;
}

function fetchJsonp(url: string): Promise<JsonpResult> {
  return new Promise((resolve, reject) => {
    const cbName = `_cv_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const timeout = setTimeout(() => { cleanup(); reject(new Error("timeout")); }, 8000);
    (window as Record<string, unknown>)[cbName] = (data: JsonpResult) => {
      cleanup();
      resolve(data);
    };
    const script = document.createElement("script");
    script.src = `${url}&format=jsonp&json_callback=${cbName}`;
    script.onerror = () => { cleanup(); reject(new Error("load error")); };
    document.head.appendChild(script);
    function cleanup() {
      clearTimeout(timeout);
      delete (window as Record<string, unknown>)[cbName];
      script.remove();
    }
  });
}

// Comic Vine volume lookup (JSONP, no CORS issues)
async function fetchComicVineBlurb(seriesTitle: string): Promise<string | null> {
  try {
    const q = cleanSearchQuery(seriesTitle);
    const url = new URL("https://comicvine.gamespot.com/api/volumes/");
    url.searchParams.set("api_key", CV_KEY);
    url.searchParams.set("filter", `name:${q}`);
    url.searchParams.set("field_list", "id,name,deck,description,count_of_issues");
    url.searchParams.set("limit", "10");

    const data = await fetchJsonp(url.toString());
    if (data.status_code !== 1) return null;

    const scored = (data.results ?? [])
      .map((r) => ({ r, score: titleRelevance(q, r.name ?? "") }))
      .filter((s) => s.score >= 0.5)
      .sort((a, b) =>
        b.score - a.score || (b.r.count_of_issues ?? 0) - (a.r.count_of_issues ?? 0)
      );

    for (const { r } of scored) {
      const text = r.deck || stripHtml(r.description ?? "");
      if (text) return text;
    }
    return null;
  } catch {
    return null;
  }
}

// Wikipedia summary lookup
async function fetchWikiSummary(query: string): Promise<string | null> {
  const q = cleanSearchQuery(query);
  const MIN_RELEVANCE = 0.5;
  try {
    const slug = encodeURIComponent(q.replace(/\s+/g, "_"));

    // Try direct slug
    const directRes = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`
    );
    if (directRes.ok) {
      const data = await directRes.json();
      if (
        data.type !== "disambiguation" &&
        data.extract &&
        titleRelevance(q, data.title as string) >= MIN_RELEVANCE
      ) {
        return data.extract as string;
      }
      // Disambiguation → try the _(comics) variant directly
      if (data.type === "disambiguation") {
        const comicsRes = await fetch(
          `https://en.wikipedia.org/api/rest_v1/page/summary/${slug}_(comics)`
        );
        if (comicsRes.ok) {
          const comicsData = await comicsRes.json();
          if (comicsData.type !== "disambiguation" && comicsData.extract) {
            return comicsData.extract as string;
          }
        }
      }
    }

    // Search fallback — prefer hits with "comic" in the title
    const searchRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q + " comic book")}&format=json&origin=*&srlimit=5`
    );
    if (searchRes.ok) {
      const searchData = await searchRes.json();
      const hits: { title: string }[] = searchData?.query?.search ?? [];
      const sorted = [...hits].sort((a, b) =>
        (/comic/i.test(b.title) ? 1 : 0) - (/comic/i.test(a.title) ? 1 : 0)
      );
      for (const hit of sorted) {
        if (titleRelevance(q, hit.title) < MIN_RELEVANCE) continue;
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
    if (!item) { setSummary(null); return; }
    setLoading(true);
    setSummary(null);
    const load = async () => {
      if (item.seriesTitle) {
        const cvBlurb = await fetchComicVineBlurb(item.seriesTitle);
        if (cvBlurb) { setSummary(cvBlurb); setLoading(false); return; }
      }
      const wikiBlurb = await fetchWikiSummary(item.wikiQuery);
      setSummary(wikiBlurb);
      setLoading(false);
    };
    load();
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
