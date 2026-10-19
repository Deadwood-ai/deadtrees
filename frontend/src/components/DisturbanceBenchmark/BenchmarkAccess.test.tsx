// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import BenchmarkAccess, { useBenchmarkAsset } from "./BenchmarkAccess";

const privileges = vi.hoisted(() => ({
  canAudit: true,
  isLoading: false,
  isError: false,
  refetch: () => Promise.resolve(),
}));
const files = vi.hoisted(() => ({ fetchBenchmarkFiles: vi.fn() }));
vi.mock("../../hooks/useAuthProvider", () => ({
  useAuth: () => ({ user: { id: "core-user" } }),
}));
vi.mock("../../hooks/useUserPrivileges", () => ({
  useCanAudit: () => privileges,
}));
vi.mock("../../api/disturbanceBenchmark", () => files);

afterEach(() => {
  cleanup();
  files.fetchBenchmarkFiles.mockReset();
  Object.assign(privileges, { canAudit: true, isError: false });
});

function Viewer() {
  const asset = useBenchmarkAsset();
  return <p>{asset("/data/Fire_Peru_2024/site.json")}</p>;
}

function renderGate() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/releases/disturbance-benchmark"]}>
        <Routes>
          <Route
            path="/releases/disturbance-benchmark"
            element={
              <BenchmarkAccess>
                <Viewer />
              </BenchmarkAccess>
            }
          />
          <Route path="/releases" element={<p>Public releases</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Disturbance benchmark core-team gate", () => {
  it("sends users outside the core team to the public releases without asking for links", async () => {
    privileges.canAudit = false;
    renderGate();
    await screen.findByText("Public releases");
    expect(files.fetchBenchmarkFiles).not.toHaveBeenCalled();
  });

  it("offers a retry when the privilege check fails, instead of redirecting", async () => {
    Object.assign(privileges, { canAudit: false, isError: true });
    renderGate();
    await screen.findByText("The benchmark couldn’t load");
    expect(screen.queryByText("Public releases")).toBeNull();
  });

  it("serves the export from the signed storage link", async () => {
    files.fetchBenchmarkFiles.mockResolvedValue({
      filesUrl:
        "https://storage.test/api/v1/disturbance-benchmark/files/abc.sig",
      expiresAt: Date.now() / 1000 + 3600,
    });
    renderGate();
    await screen.findByText(
      "https://storage.test/api/v1/disturbance-benchmark/files/abc.sig/Fire_Peru_2024/site.json",
    );
  });

  it("shows a retry instead of the viewer when the server refuses the links", async () => {
    files.fetchBenchmarkFiles.mockRejectedValue(new Error("Denied"));
    renderGate();
    await screen.findByText("The benchmark couldn’t load");
    expect(screen.queryByText(/site\.json/)).toBeNull();
  });
});
