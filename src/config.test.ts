import { beforeEach, describe, expect, it } from "vitest";
import {
  BUILT_IN_DRIVE_FOLDER_ID,
  EMPTY_CONFIG,
  clearConfig,
  getConfig,
  isDriveConfigured,
  isGithubConfigured,
  saveConfig,
} from "./config";

describe("config", () => {
  beforeEach(() => localStorage.clear());

  it("returns baked-in Drive defaults when nothing stored", () => {
    expect(getConfig().driveFolderId).toBe(BUILT_IN_DRIVE_FOLDER_ID);
    expect(isDriveConfigured()).toBe(true);
    expect(isGithubConfigured()).toBe(false);
  });

  it("round-trips save → get", () => {
    saveConfig({
      ...EMPTY_CONFIG,
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

  it("clear restores baked-in Drive defaults", () => {
    saveConfig({ ...EMPTY_CONFIG, driveFolderId: "x", driveApiKey: "y" });
    clearConfig();
    expect(getConfig().driveFolderId).toBe(BUILT_IN_DRIVE_FOLDER_ID);
  });

  it("survives corrupt JSON by returning defaults", () => {
    localStorage.setItem("netcomix.config.v1", "{not-json");
    expect(getConfig().driveFolderId).toBe(BUILT_IN_DRIVE_FOLDER_ID);
  });

  it("isDriveConfigured requires both folder + key", () => {
    expect(isDriveConfigured({ ...EMPTY_CONFIG, driveFolderId: "a" })).toBe(false);
    expect(isDriveConfigured({ ...EMPTY_CONFIG, driveApiKey: "b" })).toBe(false);
  });

  it("__forceStatic in localStorage opts out of baked-in defaults", () => {
    localStorage.setItem("netcomix.config.v1", JSON.stringify({ __forceStatic: true }));
    expect(getConfig().driveFolderId).toBe("");
    expect(isDriveConfigured()).toBe(false);
  });
});
