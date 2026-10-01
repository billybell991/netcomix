// Shared types between harvester output and the reader app

/**
 * A "beat" — a single thing the eye reads inside a panel: a speech balloon,
 * thought bubble, or narrative caption box. Beats are ordered in reading
 * sequence so the reader can snap from one to the next, mimicking how a human
 * actually consumes a panel (look into the words, not just the box).
 */
export interface FocusRegion {
  /** Bounding box in original image pixel coordinates */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Center point (precomputed for snap math) */
  centerX: number;
  centerY: number;
  /** What kind of text region this is (for debug tinting / future styling) */
  kind?: "balloon" | "caption";
}

export interface Panel {
  /** Bounding box in original image pixel coordinates */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Center point (precomputed for snap math) */
  centerX: number;
  centerY: number;
  /**
   * Ordered text beats inside this panel (speech balloons / captions).
   * Empty or absent = no sub-reading; the panel is read as a whole.
   */
  beats?: FocusRegion[];
}

export interface PageManifest {
  /** Relative image filename within the issue folder (static-mode lookup) */
  file: string;
  /** Drive file id (drive-mode lookup) */
  fileId?: string;
  /** Full image URL (api-mode — takes priority over fileId and file) */
  url?: string;
  /** Original image dimensions */
  width: number;
  height: number;
  /** Panels in reading order (top-to-bottom, left-to-right). Empty = full-page only (e.g. cover). */
  panels: Panel[];
  /**
   * True when the page's panel layout was detected as unreliable (a montage /
   * collage with no clean gutters, where the splitter produced full-height
   * ribbons). Such a page is read as a whole: its `panels` are collapsed to a
   * single page-sized panel whose `beats` are every text region flattened into
   * reading order, so the reader pans through the words without snapping to
   * broken panel boxes.
   */
  montage?: boolean;
  /** Dominant color (hex) for letterbox background. Optional. */
  dominantColor?: string;
}

export interface IssueManifest {
  id: string;
  title: string;
  series: string;
  /** Cover image filename, relative to issue folder */
  cover: string;
  pages: PageManifest[];
}

export interface SeriesEntry {
  id: string;
  title: string;
  cover: string;
  issueCount: number;
  /** Folder slug for issues, e.g. "series/batman" */
  path: string;
  /** Drive file id of cover image (drive-mode) */
  coverFileId?: string;
  /** Drive file id of series.json (drive-mode) */
  seriesFileId?: string;
  /** Full cover image URL (api-mode — takes priority) */
  coverUrl?: string;
}

export interface Library {
  generatedAt: string;
  series: SeriesEntry[];
}

export interface IssueIndexEntry {
  id: string;
  title: string;
  cover: string;
  pageCount: number;
  /** Folder slug for pages, e.g. "series/batman/issue-01" */
  path: string;
  /** Drive file id of cover image (drive-mode) */
  coverFileId?: string;
  /** Drive file id of issue.json (drive-mode) */
  issueFileId?: string;
  /** Full cover image URL (api-mode — takes priority) */
  coverUrl?: string;
}

export interface SeriesIndex {
  id: string;
  title: string;
  issues: IssueIndexEntry[];
}
