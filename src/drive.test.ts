import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "./config";
import { fetchJsonById, findByName, listFolder, mediaUrl } from "./drive";

const ok = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve("") } as Response);

describe("drive", () => {
  beforeEach(() => {
    localStorage.clear();
    saveConfig({ driveFolderId: "root", driveApiKey: "TESTKEY", ghOwner: "", ghRepo: "", ghToken: "", apiUrl: "", accessCode: "" });
    vi.restoreAllMocks();
  });

  it("mediaUrl includes file id + api key", () => {
    expect(mediaUrl("abc123")).toContain("/files/abc123");
    expect(mediaUrl("abc123")).toContain("key=TESTKEY");
    expect(mediaUrl("abc123")).toContain("alt=media");
  });

  it("listFolder paginates and queries with parent + trashed filters", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => ok({ files: [{ id: "1", name: "a", mimeType: "x" }], nextPageToken: "p2" }))
      .mockImplementationOnce(() => ok({ files: [{ id: "2", name: "b", mimeType: "y" }] }));
    const files = await listFolder("FOLDER");
    expect(files).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const url1 = fetchMock.mock.calls[0][0] as string;
    expect(url1).toContain("%27FOLDER%27+in+parents");
    expect(url1).toContain("trashed+%3D+false");
    expect(url1).toContain("supportsAllDrives=true");
    expect(url1).toContain("includeItemsFromAllDrives=true");
  });

  it("findByName escapes single quotes", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => ok({ files: [] }));
    await findByName("F", "it's.json");
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("it%5C%27s.json"); // backslash-escaped, url-encoded
    expect(url).toContain("supportsAllDrives=true");
    expect(url).toContain("includeItemsFromAllDrives=true");
  });

  it("fetchJsonById parses JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => ok({ hello: "world" }));
    const data = await fetchJsonById<{ hello: string }>("F1");
    expect(data.hello).toBe("world");
  });

  it("throws on API errors", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve({ ok: false, status: 403, text: () => Promise.resolve("Forbidden") } as Response)
    );
    await expect(listFolder("X")).rejects.toThrow(/403/);
  });
});
