// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import BenchmarkAccess, { useBenchmarkAsset } from "./BenchmarkAccess";

const auth = vi.hoisted(() => ({
  session: { user: { id: "core-user" }, access_token: "session-token" } as {
    user: { id: string };
    access_token: string;
  } | null,
  status: "authenticated" as "checking" | "authenticated" | "anonymous",
}));
const privileges = vi.hoisted(() => ({ canAudit: true, isLoading: false }));
vi.mock("../../hooks/useAuthProvider", () => ({ useAuth: () => auth }));
vi.mock("../../hooks/useUserPrivileges", () => ({
  useCanAudit: () => privileges,
}));
vi.mock("../../config", () => ({
  Settings: { API_URL: "https://storage.test/api/v1" },
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  auth.session = { user: { id: "core-user" }, access_token: "session-token" };
  auth.status = "authenticated";
  privileges.canAudit = true;
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
  it.each([
    ["anonymous visitors", () => {
      auth.session = null;
      auth.status = "anonymous";
    }],
    ["signed-in users outside the core team", () => {
      privileges.canAudit = false;
    }],
  ])("sends %s to the public releases without asking the server", async (_, arrange) => {
    arrange();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    renderGate();
    await screen.findByText("Public releases");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("serves the export from the signed storage link", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        files_url: "/disturbance-benchmark/files/abc.sig",
        expires_at: Date.now() / 1000 + 3600,
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    renderGate();
    await screen.findByText(
      "https://storage.test/api/v1/disturbance-benchmark/files/abc.sig/Fire_Peru_2024/site.json",
    );
    expect(fetcher.mock.calls[0][0]).toBe(
      "https://storage.test/api/v1/disturbance-benchmark/access",
    );
    expect(fetcher.mock.calls[0][1].headers).toEqual({
      Authorization: "Bearer session-token",
    });
  });

  it("shows a retry instead of the viewer when the server refuses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Denied", { status: 403 })),
    );
    renderGate();
    await screen.findByText("The benchmark could not be opened");
    expect(screen.queryByText(/site\.json/)).toBeNull();
  });
});
