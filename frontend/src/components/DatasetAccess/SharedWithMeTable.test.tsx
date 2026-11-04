// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { DatasetAccessRole } from "../../api/datasetAccess";

const sharedRows = vi.hoisted(() => ({ current: [] as unknown[] }));
const dataset = vi.hoisted(() => ({ current: { data: undefined as unknown, isPending: true } }));

vi.mock("../../hooks/useDatasetAccess", () => ({
  useSharedWithMe: () => ({ data: sharedRows.current, isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock("../../hooks/useDatasets", () => ({
  usePublicDatasetById: () => ({ ...dataset.current, refetch: vi.fn() }),
}));
vi.mock("../EditDatasetModal", () => ({
  default: ({ dataset: loaded }: { dataset: { file_name: string } }) => <div>Editing {loaded.file_name}</div>,
}));
vi.mock("./ShareDatasetModal", () => ({
  default: ({ datasetId }: { datasetId: number | null }) => (datasetId ? <div>Sharing {datasetId}</div> : null),
}));

import SharedWithMeTable from "./SharedWithMeTable";

const row = (dataset_id: number, role: DatasetAccessRole) => ({
  dataset_id,
  role,
  can_download: false,
  expires_at: null,
  granted_at: "2026-11-01T00:00:00Z",
  data_access: "private",
  file_name: `flight-${dataset_id}.tif`,
});

const show = (rows: unknown[], url = "/profile?tab=shared") => {
  sharedRows.current = rows;
  return render(
    <MemoryRouter initialEntries={[url]}>
      <SharedWithMeTable />
    </MemoryRouter>,
  );
};

const openMenu = (fileName: string) => {
  const tableRow = screen.getByRole("link", { name: fileName }).closest("tr") as HTMLElement;
  fireEvent.click(within(tableRow).getByRole("button", { name: /Actions/ }));
};

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() }),
  });
  Element.prototype.scrollIntoView = vi.fn();
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  dataset.current = { data: undefined, isPending: true };
});

describe("SharedWithMeTable row actions", () => {
  it("shows readers no actions at all", () => {
    show([row(1, "reader")]);
    expect(screen.queryByRole("button", { name: /Actions/ })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Actions" })).toBeNull();
  });

  it("gives a reader's row no menu next to an editor's", () => {
    show([row(1, "reader"), row(2, "editor")]);
    const readerRow = screen.getByRole("link", { name: "flight-1.tif" }).closest("tr") as HTMLElement;
    expect(within(readerRow).queryByRole("button", { name: /Actions/ })).toBeNull();
  });

  it("lets an editor edit details but not share", async () => {
    show([row(2, "editor")]);
    openMenu("flight-2.tif");
    expect(await screen.findByRole("menuitem", { name: /Edit details/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Share/ })).toBeNull();
  });

  it("lets an admin share", async () => {
    show([row(3, "admin")]);
    openMenu("flight-3.tif");
    fireEvent.click(await screen.findByRole("menuitem", { name: /Share/ }));
    expect(screen.getByText("Sharing 3")).toBeTruthy();
  });

  it("opens the edit form only once the dataset has loaded", async () => {
    show([row(2, "editor")]);
    openMenu("flight-2.tif");
    fireEvent.click(await screen.findByRole("menuitem", { name: /Edit details/ }));
    expect(screen.getByRole("status", { name: "Loading dataset details" })).toBeTruthy();
    expect(screen.queryByText(/^Editing/)).toBeNull();
    cleanup();

    dataset.current = { data: { file_name: "flight-2.tif" }, isPending: false };
    show([row(2, "editor")]);
    openMenu("flight-2.tif");
    fireEvent.click(await screen.findByRole("menuitem", { name: /Edit details/ }));
    expect(screen.getByText("Editing flight-2.tif")).toBeTruthy();
  });

  it("offers a retry when the dataset cannot be loaded", async () => {
    dataset.current = { data: null, isPending: false };
    show([row(2, "editor")]);
    openMenu("flight-2.tif");
    fireEvent.click(await screen.findByRole("menuitem", { name: /Edit details/ }));
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("marks only the linked row as current", () => {
    show([row(1, "reader"), row(2, "editor")], "/profile?tab=shared&highlight=2");
    const current = screen.getByRole("link", { name: "flight-2.tif" }).closest("tr");
    expect(current?.getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("link", { name: "flight-1.tif" }).closest("tr")?.hasAttribute("aria-current")).toBe(false);
  });
});
