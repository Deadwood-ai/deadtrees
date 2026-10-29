// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { PrepackagedReleaseDownloads } from "./PrepackagedReleaseDownloads";

const query = vi.hoisted(() => ({
  data: undefined as unknown,
  isLoading: false,
  error: null as unknown,
  refetch: vi.fn(),
}));
vi.mock("../../hooks/usePrepackagedDatasets", () => ({
  usePrepackagedDatasets: () => query,
}));
vi.mock("./PrepackagedDownloadButton", () => ({
  PrepackagedDownloadButton: () => null,
}));

afterEach(() => {
  cleanup();
  Object.assign(query, { data: undefined, isLoading: false, error: null });
  query.refetch.mockReset();
});

function renderDownloads() {
  render(<PrepackagedReleaseDownloads packageSlugs={["dte-aerial-bench"]} returnTo="/releases/dte-aerial-bench" />);
}

describe("Release downloads", () => {
  it("shows placeholder lines while the catalog loads", () => {
    query.isLoading = true;
    renderDownloads();
    expect(screen.getByRole("status", { name: "Loading downloads" })).toBeTruthy();
  });

  it("offers one retry when the catalog fails", () => {
    query.error = new Error("network");
    renderDownloads();
    expect(screen.getByRole("heading", { name: "The downloads couldn’t load" })).toBeTruthy();
    expect(screen.queryByText("network")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(query.refetch).toHaveBeenCalledOnce();
  });

  it("says which package is still missing when none is published", () => {
    query.data = [];
    renderDownloads();
    expect(screen.getByTestId("release-downloads-empty").textContent).toContain("Waiting for: dte-aerial-bench");
  });
});
