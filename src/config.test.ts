import { beforeEach, describe, expect, it } from "vitest";
import { clearConfig, getConfig, isDriveConfigured, isGithubConfigured, saveConfig } from "./config";

describe("config", () => {
  beforeEach(() => localStorage.clear());

  it("returns empty config when nothing stored", () => {
    expect(getConfig().driveFolderId).toBe("");
    expect(isDriveConfigured()).toBe(false);
    expect(isGithubConfigured()).toBe(false);
  });

  it("round-trips save → get", () => {
    saveConfig({
      driveFolderId: "abc",
      driveApiKey: "key",
      ghOwner: "me",
      ghRepo: "repo",
      ghToken: "tok",
    });
    const c = getConfig();
    expect(c.driveFolderId).toBe("abc");
    expect(isDriveConfigured()).toBe(true);
    expect(isGithubConfigured()).toBe(true);
  });

  it("clear removes config", () => {
    saveConfig({ driveFolderId: "x", driveApiKey: "y", ghOwner: "", ghRepo: "", ghToken: "" });
    clearConfig();
    expect(getConfig().driveFolderId).toBe("");
  });

  it("survives corrupt JSON", () => {
    localStorage.setItem("netcomix.config.v1", "{not-json");
    expect(getConfig().driveFolderId).toBe("");
  });

  it("isDriveConfigured requires both folder + key", () => {
    expect(isDriveConfigured({ driveFolderId: "a", driveApiKey: "", ghOwner: "", ghRepo: "", ghToken: "" })).toBe(false);
    expect(isDriveConfigured({ driveFolderId: "", driveApiKey: "b", ghOwner: "", ghRepo: "", ghToken: "" })).toBe(false);
  });
});
