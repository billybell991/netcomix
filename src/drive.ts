// Google Drive REST v3 client (read-only, uses API key).
// Requires a publicly-shared Drive folder ("Anyone with the link can view").

import { getConfig } from "./config";

const DRIVE_API = "https://www.googleapis.com/drive/v3";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
}

interface DriveListResponse {
  files: DriveFile[];
  nextPageToken?: string;
}

function apiKey(): string {
  const k = getConfig().driveApiKey;
  if (!k) throw new Error("Drive API key not configured");
  return k;
}

/** List children of a Drive folder. Returns all pages. */
export async function listFolder(folderId: string, mimeFilter?: string): Promise<DriveFile[]> {
  const q = [`'${folderId}' in parents`, "trashed = false"];
  if (mimeFilter) q.push(`mimeType = '${mimeFilter}'`);
  const params = new URLSearchParams({
    q: q.join(" and "),
    fields: "files(id,name,mimeType),nextPageToken",
    pageSize: "1000",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    key: apiKey(),
  });
  const out: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(`${DRIVE_API}/files?${params}`);
    if (!res.ok) throw new Error(`Drive list failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as DriveListResponse;
    out.push(...data.files);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

/** Find a single file by exact name in a folder. */
export async function findByName(folderId: string, name: string): Promise<DriveFile | null> {
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and name = '${name.replace(/'/g, "\\'")}' and trashed = false`,
    fields: "files(id,name,mimeType)",
    pageSize: "1",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    key: apiKey(),
  });
  const res = await fetch(`${DRIVE_API}/files?${params}`);
  if (!res.ok) throw new Error(`Drive findByName failed: ${res.status}`);
  const data = (await res.json()) as DriveListResponse;
  return data.files[0] ?? null;
}

/** URL to download a file's media (binary or text). Suitable for <img src>. */
export function mediaUrl(fileId: string): string {
  return `${DRIVE_API}/files/${fileId}?alt=media&supportsAllDrives=true&key=${encodeURIComponent(apiKey())}`;
}

/** Fetch and parse a JSON file by Drive file id. */
export async function fetchJsonById<T>(fileId: string): Promise<T> {
  const res = await fetch(mediaUrl(fileId), { cache: "no-cache" });
  if (!res.ok) throw new Error(`Drive fetch ${fileId} failed: ${res.status}`);
  return (await res.json()) as T;
}
