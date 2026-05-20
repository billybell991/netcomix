import { beforeEach, describe, expect, it } from "vitest";
import {
  EMPTY_CONFIG,
  clearConfig,
  getConfig,
  isGithubConfigured,
  saveConfig,
} from "./config";

describe("config", () => {
  beforeEach(() => localStorage.clear());

  it("returns empty defaults when nothing stored", () => {
    expect(getConfig().ghOwner).toBe("");
    expect(isGithubConfigured()).toBe(false);
  });

  it("round-trips save → get", () => {
    saveConfig({ ...EMPTY_CONFIG, ghOwner: "me", ghRepo: "repo", ghToken: "tok" });
    const c = getConfig();
    expect(c.ghOwner).toBe("me");
    expect(c.ghRepo).toBe("repo");
    expect(isGithubConfigured()).toBe(true);
  });

  it("clear restores empty defaults", () => {
    saveConfig({ ...EMPTY_CONFIG, ghOwner: "x", ghRepo: "y", ghToken: "z" });
    clearConfig();
    expect(getConfig().ghOwner).toBe("");
    expect(isGithubConfigured()).toBe(false);
  });

  it("survives corrupt JSON by returning defaults", () => {
    localStorage.setItem("netcomix.config.v1", "{not-json");
    expect(getConfig().ghOwner).toBe("");
    expect(isGithubConfigured()).toBe(false);
  });

  it("isGithubConfigured requires owner + repo + token", () => {
    expect(isGithubConfigured({ ...EMPTY_CONFIG, ghOwner: "a" })).toBe(false);
    expect(isGithubConfigured({ ...EMPTY_CONFIG, ghOwner: "a", ghRepo: "b" })).toBe(false);
    expect(isGithubConfigured({ ...EMPTY_CONFIG, ghOwner: "a", ghRepo: "b", ghToken: "c" })).toBe(true);
  });
});

