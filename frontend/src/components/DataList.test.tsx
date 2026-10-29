// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("./ListItem", () => ({ default: () => null }));

import DataList from "./DataList";

afterEach(cleanup);

describe("Drone archive list", () => {
  it("explains an empty result with the shared empty state", () => {
    render(
      <DataList
        data={[]}
        hoveredItem={null}
        setHoveredItem={() => {}}
        visibleFeatures={[]}
        onFilterClick={() => {}}
        searchValue=""
        filterByViewport
      />,
    );
    const empty = screen.getByTestId("dataset-empty-results");
    expect(empty.textContent).toContain("No drone images match");
    expect(empty.textContent).toContain("Zoom out, move the map or clear a filter to see more.");
  });
});
