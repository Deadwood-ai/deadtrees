import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import PriwaWarnkarteStatus from "./PriwaWarnkarteStatus";

describe("PriwaWarnkarteStatus", () => {
  it("renders the safe German date label for members", () => {
    const html = renderToStaticMarkup(
      createElement(PriwaWarnkarteStatus, {
        sourceDate: "2024-06-25",
        isPreviewing: false,
      }),
    );

    expect(html).toContain("Warnkarte vom 25.06.2024");
    expect(html).not.toContain("checksum");
  });

  it("marks an unpublished admin overlay as a preview", () => {
    const html = renderToStaticMarkup(
      createElement(PriwaWarnkarteStatus, {
        sourceDate: "2024-06-25",
        isPreviewing: true,
      }),
    );

    expect(html).toContain("Vorschau");
  });
});
