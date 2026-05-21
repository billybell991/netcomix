// Shared types between harvester output and the reader app

export interface Panel {
  /** Bounding box in original image pixel coordinates */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Center point (precomputed for snap math) */
  centerX: number;
  centerY: number;
}

/** Text-shifted snap center for a single zone (produced by the bubble detector). */
export interface ZoneTextCenter {
  cx: number;
  cy: number;
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
  /** Dominant color (hex) for letterbox background. Optional. */
  dominantColor?: string;
  /**
   * Per-zone text snap centers (TL→TR→ML→MR→BL→BR, 6 entries).
   * Produced by the speech-bubble detector in the harvester.
   * null entry = no text in that zone → reader uses geometric zone center.
   * Absent entirely = issue predates text detection → all zones use geometric centers.
   */
  zone_text_centers?: (ZoneTextCenter | null)[] | null;
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
