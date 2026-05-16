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

export interface PageManifest {
  /** Relative image filename within the issue folder */
  file: string;
  /** Original image dimensions */
  width: number;
  height: number;
  /** Panels in reading order (top-to-bottom, left-to-right). Empty = full-page only (e.g. cover). */
  panels: Panel[];
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
}

export interface SeriesIndex {
  id: string;
  title: string;
  issues: IssueIndexEntry[];
}
