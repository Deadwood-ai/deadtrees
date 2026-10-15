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
});
