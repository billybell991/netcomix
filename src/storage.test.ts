import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./settings";
import { getFavorites, isFavorite, getProgress, setProgress, toggleFavorite,
         getLastRead, setLastRead, getInProgressSeriesIds, getSeriesStartedFraction } from "./storage";

describe("settings", () => {
  beforeEach(() => localStorage.clear());

  it("returns defaults when nothing saved", () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("persists and reloads", () => {
    saveSettings({ ...DEFAULT_SETTINGS, buttonOpacity: 0.5, sounds: false });
    const loaded = loadSettings();
    expect(loaded.buttonOpacity).toBe(0.5);
    expect(loaded.sounds).toBe(false);
    expect(loaded.haptics).toBe(DEFAULT_SETTINGS.haptics);
  });

  it("merges defaults for missing keys (forward compat)", () => {
    localStorage.setItem("netcomix.settings.v2", JSON.stringify({ sounds: false }));
    const loaded = loadSettings();
    expect(loaded.sounds).toBe(false);
    expect(loaded.buttonOpacity).toBe(DEFAULT_SETTINGS.buttonOpacity);
  });
});

describe("favorites + progress", () => {
  beforeEach(() => localStorage.clear());

  it("toggleFavorite adds and removes", () => {
    expect(getFavorites()).toEqual([]);
    toggleFavorite("a");
    expect(isFavorite("a")).toBe(true);
    toggleFavorite("a");
    expect(isFavorite("a")).toBe(false);
  });

  it("multiple favorites persist", () => {
    toggleFavorite("a");
    toggleFavorite("b");
    expect(getFavorites().sort()).toEqual(["a", "b"]);
  });

  it("progress get/set", () => {
    expect(getProgress("x")).toBeUndefined();
    setProgress("x", "3:2");
    expect(getProgress("x")).toBe("3:2");
    setProgress("x", "4:0");
    expect(getProgress("x")).toBe("4:0");
  });
});

describe("lastRead", () => {
  beforeEach(() => localStorage.clear());

  it("returns null when nothing saved", () => {
    expect(getLastRead()).toBeNull();
  });

  it("persists and reloads", () => {
    setLastRead("my-series", "my-series-01");
    expect(getLastRead()).toEqual({ seriesId: "my-series", issueId: "my-series-01" });
  });

  it("overwrites previous value", () => {
    setLastRead("series-a", "series-a-01");
    setLastRead("series-b", "series-b-01");
    expect(getLastRead()).toEqual({ seriesId: "series-b", issueId: "series-b-01" });
  });

  it("returns null when localStorage has corrupt data", () => {
    localStorage.setItem("netcomix.lastread.v1", "not-json{{");
    expect(getLastRead()).toBeNull();
  });
});

describe("getInProgressSeriesIds", () => {
  beforeEach(() => localStorage.clear());

  it("returns empty array when no progress", () => {
    expect(getInProgressSeriesIds(["my-series"])).toEqual([]);
  });

  it("excludes series whose only progress is page 0", () => {
    setProgress("my-series-01", "0:-1");
    expect(getInProgressSeriesIds(["my-series"])).toEqual([]);
  });

  it("includes series where an issue has pageIndex > 0", () => {
    setProgress("my-series-01", "3:1");
    expect(getInProgressSeriesIds(["my-series"])).toContain("my-series");
  });

  it("matches issue to series by prefix + hyphen", () => {
    setProgress("tales-from-the-crypt-v2-01-2007", "5:0");
    const ids = getInProgressSeriesIds(["tales-from-the-crypt-v2", "other-series"]);
    expect(ids).toContain("tales-from-the-crypt-v2");
    expect(ids).not.toContain("other-series");
  });

  it("deduplicates — multiple issues in same series count once", () => {
    setProgress("my-series-01", "2:0");
    setProgress("my-series-02", "4:0");
    const ids = getInProgressSeriesIds(["my-series"]);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toBe("my-series");
  });
});

describe("getSeriesStartedFraction", () => {
  beforeEach(() => localStorage.clear());

  it("returns 0 when no progress", () => {
    expect(getSeriesStartedFraction("my-series", 4)).toBe(0);
  });

  it("returns 0 when issueCount is 0", () => {
    setProgress("my-series-01", "3:0");
    expect(getSeriesStartedFraction("my-series", 0)).toBe(0);
  });

  it("counts started issues over total", () => {
    setProgress("my-series-01", "2:0");  // started
    setProgress("my-series-02", "0:0");  // not started (pageIndex 0)
    expect(getSeriesStartedFraction("my-series", 4)).toBe(0.25); // 1/4
  });

  it("caps at 1 even if more issues recorded than issueCount", () => {
    setProgress("my-series-01", "2:0");
    setProgress("my-series-02", "2:0");
    setProgress("my-series-03", "2:0");
    expect(getSeriesStartedFraction("my-series", 2)).toBe(1); // capped
  });
});
