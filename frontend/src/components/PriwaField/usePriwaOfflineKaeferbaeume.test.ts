import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import type { IPriwaPoint } from "./types";
import type { IPriwaQueuedMutation } from "./priwaOfflineStore";

const setStateSpy = vi.fn();
const invalidateQueries = vi.fn();
let stateValues: unknown[] = [];
let isOnline = false;
let queryData: IPriwaPoint[] | undefined;

const basePoint: IPriwaPoint = {
  id: "point-1",
  lat: 48.456,
  lon: 8.18,
  baumnr: "42",
  fund: "ja",
  baumart: "Fichte",
  bm: "ja",
  bohrloch: "ja",
  harz: "nein",
  grueneNadelnAmBoden: "nein",
  nadel: "grün",
  rinde: "0%",
  kv: "0%",
  name: "Sigi Huber",
  datum: "2026-05-19",
  kom: "",
  capturedAt: "2026-05-19T08:00:00.000Z",
  coordinateSource: "qr",
  gps: "ja",
};

const queuedUpdate: IPriwaQueuedMutation = {
  id: "project-1:user-1:point-1",
  projectId: "project-1",
  userId: "user-1",
  pointId: "point-1",
  type: "update",
  point: { ...basePoint, baumnr: "43" },
  queuedAt: "2026-05-19T08:01:00.000Z",
  updatedAt: "2026-05-19T08:01:00.000Z",
  retryCount: 0,
  status: "pending",
};

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: (callback: unknown) => callback,
    useEffect: vi.fn(),
    useMemo: (factory: () => unknown) => factory(),
    useRef: (value: unknown) => ({ current: value }),
    useState: vi.fn((initialValue: unknown) => {
      const value =
        stateValues.length > 0
          ? stateValues.shift()
          : typeof initialValue === "function"
            ? (initialValue as () => unknown)()
            : initialValue;
      return [value, setStateSpy];
    }),
  };
});

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(() => ({
    data: queryData,
    isLoading: false,
    isRefetching: false,
    error: null,
  })),
  useQueryClient: vi.fn(() => ({ invalidateQueries })),
}));

vi.mock("../../hooks/useAuthProvider", () => ({
  useAuth: vi.fn(() => ({
    user: { id: "user-1" },
  })),
}));

vi.mock("./usePriwaOfflineStatus", () => ({
  usePriwaOfflineStatus: vi.fn(() => ({
    isOnline,
    serviceWorker: { status: "ready", errorMessage: null },
  })),
}));

vi.mock("./usePriwaKaeferbaeume", () => ({
  fetchPriwaKaeferbaeume: vi.fn(),
  priwaPointsQueryKey: vi.fn((projectId) => ["priwa-kaeferbaeume", projectId]),
  softDeletePriwaKaeferbaum: vi.fn(),
  upsertPriwaKaeferbaum: vi.fn(),
}));

vi.mock("./usePriwaBefallsgruppen", () => ({
  priwaBefallsgruppenQueryKey: vi.fn((projectId) => [
    "priwa-befallsgruppen",
    projectId,
  ]),
}));

vi.mock("./priwaOfflineStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./priwaOfflineStore")>();
  return {
    ...actual,
    loadCachedPriwaPoints: vi.fn(),
    loadPriwaSyncQueue: vi.fn(),
    saveCachedPriwaPoints: vi.fn(),
    savePriwaSyncQueue: vi.fn(),
  };
});

describe("usePriwaOfflineKaeferbaeume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateValues = [];
    isOnline = false;
    queryData = undefined;
  });

  it("merges cached points with queued local edits", async () => {
    stateValues = [[basePoint], [queuedUpdate], false, false];
    const { usePriwaOfflineKaeferbaeume } =
      await import("./usePriwaOfflineKaeferbaeume");

    const result = usePriwaOfflineKaeferbaeume("project-1");

    expect(result.points).toEqual([
      expect.objectContaining({
        id: "point-1",
        baumnr: "43",
        syncStatus: "pending",
        syncOperation: "update",
      }),
    ]);
    expect(result.syncSummary).toEqual({
      pending: 1,
      syncing: 0,
      failed: 0,
      total: 1,
    });
  });

  it("stores an offline create in the point cache and sync queue", async () => {
    stateValues = [[], [], false, false];
    const offlineStore = await import("./priwaOfflineStore");
    (offlineStore.loadCachedPriwaPoints as Mock).mockResolvedValue([]);
    (offlineStore.loadPriwaSyncQueue as Mock).mockResolvedValue([]);
    const { usePriwaOfflineKaeferbaeume } =
      await import("./usePriwaOfflineKaeferbaeume");

    const result = usePriwaOfflineKaeferbaeume("project-1");
    await result.createPoint(basePoint);

    expect(offlineStore.saveCachedPriwaPoints).toHaveBeenCalledWith(
      "project-1",
      [basePoint],
    );
    expect(offlineStore.savePriwaSyncQueue).toHaveBeenCalledWith(
      "project-1",
      "user-1",
      [
        expect.objectContaining({
          projectId: "project-1",
          userId: "user-1",
          pointId: "point-1",
          type: "create",
          point: basePoint,
          status: "pending",
        }),
      ],
    );
  });

  it("uses the local cache ahead of stale query data when both exist", async () => {
    queryData = [{ ...basePoint, baumnr: "server-stale" }];
    stateValues = [[{ ...basePoint, baumnr: "cache-fresh" }], [], false, false];
    const { usePriwaOfflineKaeferbaeume } =
      await import("./usePriwaOfflineKaeferbaeume");

    const result = usePriwaOfflineKaeferbaeume("project-1");

    expect(result.points).toEqual([
      expect.objectContaining({
        id: "point-1",
        baumnr: "cache-fresh",
      }),
    ]);
  });
});
