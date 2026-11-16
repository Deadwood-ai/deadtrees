// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IDatasetArchiveItem } from "../types/dataset";

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
        filterByViewport
      />,
    );
    const empty = screen.getByTestId("dataset-empty-results");
    expect(empty.textContent).toContain("No drone images match");
    expect(empty.textContent).toContain("Clear a filter or change the search to see more.");
  });

  it("keeps the map-view filter while searching and offers to show hidden matches", () => {
    const onZoomToMatches = vi.fn();
    const item = { id: 7 } as IDatasetArchiveItem;
    render(
      <DataList
        data={[item, { id: 8 } as IDatasetArchiveItem]}
        hoveredItem={null}
        setHoveredItem={() => {}}
        visibleFeatures={[]}
        onFilterClick={() => {}}
        filterByViewport
        onZoomToMatches={onZoomToMatches}
        scores={new Map([[7, 0.9]])}
      />,
    );
    const empty = screen.getByTestId("dataset-empty-results");
    expect(empty.textContent).toContain("No matches in this map view");
    expect(empty.textContent).toContain("2 images match elsewhere.");
    fireEvent.click(screen.getByTestId("dataset-zoom-to-matches"));
    expect(onZoomToMatches).toHaveBeenCalledOnce();
  });
});
