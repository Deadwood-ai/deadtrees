import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import PriwaWarnkarteLegend from "./PriwaWarnkarteLegend";

describe("PriwaWarnkarteLegend", () => {
  it("combines the active date and ten probability bands", () => {
    const html = renderToStaticMarkup(
      createElement(PriwaWarnkarteLegend, {
        sourceDate: "2024-06-25",
        onDismiss: () => undefined,
      }),
    );

    expect(html).toContain("Warnkarte 25.06.2024");
    expect(html).toContain("Wahrscheinlichkeit");
    expect(html.match(/aria-label="Wahrscheinlichkeit/g)).toHaveLength(10);
    expect(html).toContain('aria-label="Warnkarten-Legende schließen"');
    expect(html).not.toContain("Vorschau");
  });

  it("omits the dismiss control when no matching restore path exists", () => {
    const html = renderToStaticMarkup(
      createElement(PriwaWarnkarteLegend, {
        sourceDate: "2024-06-25",
      }),
    );

    expect(html).not.toContain('aria-label="Warnkarten-Legende schließen"');
  });
});
