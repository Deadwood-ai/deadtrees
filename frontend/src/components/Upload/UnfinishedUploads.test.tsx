// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({ listed: [] as unknown[], status: null as unknown }));
const addProcess = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("../../hooks/useAuthProvider", () => ({ useAuth: () => ({ user: { id: "user-1" } }) }));
vi.mock("../../hooks/useAnalytics", () => ({ useAnalytics: () => ({ track: vi.fn() }) }));
vi.mock("../../hooks/useResumableUpload", () => ({
  getAccessToken: async () => "token",
  useResumableUpload: () => vi.fn(),
}));
vi.mock("../../api/addProcess", () => ({ default: addProcess }));
vi.mock("../../api/uploadOrtho", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/uploadOrtho")>()),
  listUnfinishedUploads: async () => api.listed,
  fetchUploadStatus: async () => api.status,
}));

import UnfinishedUploads from "./UnfinishedUploads";
import { pendingUploadsFor, savePendingUpload } from "../../utils/pendingUploads";

const remember = () =>
  savePendingUpload({
    uploadId: "up-1",
    userId: "user-1",
    fileName: "flight.tif",
    fileSize: 100,
    chunkSize: 50,
    metadata: { license: "CC BY", platform: "drone", authors: ["A"], upload_type: "geotiff" },
    processingSteps: ["geotiff", "cog"],
  });

const serverStatus = (state: string, extra: Record<string, unknown> = {}) => ({
  upload_id: "up-1",
  state,
  chunks_total: 2,
  chunks_received: state === "complete" ? 2 : 1,
  bytes_received: state === "complete" ? 100 : 50,
  last_chunk: { size: 50, sha256: "x" },
  contract: { file_name: "flight.tif" },
  response: null,
  created_at: 1,
  updated_at: 1_700_000_000,
  ...extra,
});

describe("unfinished uploads panel", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    addProcess.mockClear();
    api.listed = [];
    api.status = null;
  });

  it("offers to continue an upload the server holds part of", async () => {
    remember();
    api.listed = [serverStatus("receiving")];
    render(<UnfinishedUploads />);
    expect(await screen.findByText("Unfinished upload: flight.tif")).toBeTruthy();
    expect(screen.getByText(/50 % uploaded/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue upload" })).toBeTruthy();
  });

  it("starts processing once for a file stored before the page closed", async () => {
    // The tab closed while the last chunk was finalized: the server stored the
    // dataset, and the browser never reached its processing request.
    remember();
    api.status = serverStatus("complete", { response: { id: "42" } });
    render(<UnfinishedUploads />);
    fireEvent.click(await screen.findByRole("button", { name: "Start processing" }));
    await waitFor(() => expect(addProcess).toHaveBeenCalledTimes(1));
    expect(addProcess).toHaveBeenCalledWith(42, ["geotiff", "cog"], "token");
    expect(pendingUploadsFor("user-1")).toEqual([]);
    expect(screen.queryByText(/processing has not started/)).toBeNull();
  });

  it("shows nothing when no upload is unfinished", async () => {
    const { container } = render(<UnfinishedUploads />);
    await waitFor(() => expect(container.innerHTML).toBe(""));
  });
});
