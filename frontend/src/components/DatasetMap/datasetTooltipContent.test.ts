// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { renderDatasetTooltipContent } from "./datasetTooltipContent";

describe("renderDatasetTooltipContent", () => {
  it("shows the title and date", () => {
    const element = document.createElement("div");
    renderDatasetTooltipContent(element, "Freiburg, Germany", "2023-05-01");

    expect(element.querySelector(".tooltip-content")?.textContent).toBe(
      "Freiburg, Germany (2023-05-01)",
    );
  });

  it("keeps markup in the title as plain text", () => {
    const element = document.createElement("div");
    const title = '<img src="x" onerror="alert(1)">';
    renderDatasetTooltipContent(element, title, "2023");

    expect(element.querySelector("img")).toBeNull();
    expect(element.textContent).toBe(`${title} (2023)`);
  });

  it("replaces earlier content", () => {
    const element = document.createElement("div");
    renderDatasetTooltipContent(element, "first", "2020");
    renderDatasetTooltipContent(element, "second", "2021");

    expect(element.querySelectorAll(".tooltip-content")).toHaveLength(1);
    expect(element.textContent).toBe("second (2021)");
  });
});
