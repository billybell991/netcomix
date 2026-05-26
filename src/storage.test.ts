import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./settings";
import { getFavorites, isFavorite, getProgress, setProgress, toggleFavorite } from "./storage";

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
