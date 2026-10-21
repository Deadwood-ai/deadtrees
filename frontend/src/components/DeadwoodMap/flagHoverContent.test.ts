// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { renderFlagHoverContent } from "./flagHoverContent";

describe("renderFlagHoverContent", () => {
  it("shows the flag id, year and description", () => {
    const element = document.createElement("div");
    renderFlagHoverContent(element, {
      flagId: 12,
      year: 2024,
      description: "Clouds over the north part",
    });

    expect(element.textContent).toContain("Flag #12 · 2024");
    expect(element.textContent).toContain("Clouds over the north part");
  });

  it("keeps markup in the description as plain text", () => {
    const element = document.createElement("div");
    const description = '<img src="x" onerror="alert(1)"><script>alert(2)</script>';
    renderFlagHoverContent(element, { flagId: 3, description });

    expect(element.querySelector("img")).toBeNull();
    expect(element.querySelector("script")).toBeNull();
    expect(element.textContent).toContain(description);
  });

  it("handles a missing year and description", () => {
    const element = document.createElement("div");
    renderFlagHoverContent(element, { flagId: 7, description: null });

    expect(element.textContent).toBe("Flag #7");
  });
});
