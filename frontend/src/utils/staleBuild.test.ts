import { describe, expect, it, vi } from "vitest";

import { isStaleBuildError, reloadForNewBuild } from "./staleBuild";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe("isStaleBuildError", () => {
  it.each([
    "Failed to fetch dynamically imported module: https://deadtrees.earth/assets/About-abc.js",
    "Importing a module script failed.",
    "error loading dynamically imported module",
    "Unable to preload CSS for /assets/Dataset-123.css",
  ])("recognises %s", (message) => {
    expect(isStaleBuildError(new TypeError(message))).toBe(true);
  });

  it("ignores ordinary render errors", () => {
    expect(
      isStaleBuildError(new TypeError("Cannot read properties of undefined")),
    ).toBe(false);
    expect(isStaleBuildError(null)).toBe(false);
  });
});

describe("reloadForNewBuild", () => {
  it("reloads once, then leaves the next failure to the error page", () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    expect(reloadForNewBuild(storage, reload, 1_000_000)).toBe(true);
    expect(reloadForNewBuild(storage, reload, 1_010_000)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads again after the cooldown", () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    reloadForNewBuild(storage, reload, 1_000_000);
    expect(reloadForNewBuild(storage, reload, 1_031_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("does not reload without storage to guard the loop", () => {
    const reload = vi.fn();
    expect(reloadForNewBuild(undefined, reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
