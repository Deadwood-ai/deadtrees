import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import BenchmarkScores from "./BenchmarkScores";

describe("benchmark score availability", () => {
  it("shows NA rather than zero when no evaluation was supplied", () => {
    const html = renderToStaticMarkup(createElement(BenchmarkScores, {}));
    expect(html.match(/<strong>NA<\/strong>/g)).toHaveLength(3);
    expect(html).not.toContain("0.0%");
  });

  it("shows zero recall and F1 for a covered product with no detections", () => {
    const html = renderToStaticMarkup(createElement(BenchmarkScores, {
      counts: { tp: 0, fp: 0, fn: 12, tn: 30 },
    }));
    expect(html.match(/<strong>NA<\/strong>/g)).toHaveLength(1);
    expect(html).toContain("<strong>0.0%</strong>");
    expect(html).toContain("<strong>0.00</strong>");
  });

  it("keeps undefined positive-class scores unavailable", () => {
    const html = renderToStaticMarkup(createElement(BenchmarkScores, {
      counts: { tp: 0, fp: 0, fn: 0, tn: 30 },
    }));
    expect(html.match(/<strong>NA<\/strong>/g)).toHaveLength(3);
  });
});
