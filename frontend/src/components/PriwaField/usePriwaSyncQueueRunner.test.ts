import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IPriwaQueuedMutation } from "./priwaOfflineStore";
import { PRIWA_SYNC_REQUEST_TIMEOUT_MS } from "./priwaSyncRequest";
import type { IPriwaPoint } from "./types";

const mocks = vi.hoisted(() => ({
  loadQueue: vi.fn(),
  saveQueue: vi.fn(),
  softDeletePoint: vi.fn(),
  upsertPoint: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: (callback: unknown) => callback,
    useRef: (value: unknown) => ({ current: value }),
  };
});

vi.mock("./priwaOfflineStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./priwaOfflineStore")>();
  return {
    ...actual,
    loadPriwaSyncQueue: mocks.loadQueue,
    savePriwaSyncQueue: mocks.saveQueue,
  };
});

vi.mock("./usePriwaKaeferbaeume", () => ({
  softDeletePriwaKaeferbaum: mocks.softDeletePoint,
  upsertPriwaKaeferbaum: mocks.upsertPoint,
}));

const point: IPriwaPoint = {
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

const interruptedMutation: IPriwaQueuedMutation = {
  id: "project-1:user-1:point-1",
  projectId: "project-1",
  userId: "user-1",
  pointId: "point-1",
  type: "create",
  point,
  queuedAt: "2026-05-19T08:01:00.000Z",
  updatedAt: "2026-05-19T08:01:00.000Z",
  retryCount: 1,
  status: "syncing",
};

describe("usePriwaSyncQueueRunner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.upsertPoint.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries and drains a syncing mutation left behind by an interruption", async () => {
    let storedQueue = [interruptedMutation];
    mocks.loadQueue.mockImplementation(async () => storedQueue);
    mocks.saveQueue.mockImplementation(
      async (
        _projectId: string,
        _userId: string,
        queue: IPriwaQueuedMutation[],
      ) => {
        storedQueue = queue;
      },
    );
    const onQueueDrained = vi.fn().mockResolvedValue(undefined);
    const { usePriwaSyncQueueRunner } =
      await import("./usePriwaSyncQueueRunner");
    const runner = usePriwaSyncQueueRunner({
      projectId: "project-1",
      userId: "user-1",
      isOnline: true,
      onQueueUpdated: vi.fn(),
      onPointSynced: vi.fn(),
      onPointDeleted: vi.fn(),
      onQueueDrained,
    });

    await runner.syncQueue();

    expect(mocks.upsertPoint).toHaveBeenCalledWith(
      "project-1",
      point,
      expect.any(AbortSignal),
    );
    expect(storedQueue).toEqual([]);
    expect(onQueueDrained).toHaveBeenCalledOnce();
  });

  it("marks a stalled request as failed after the sync timeout", async () => {
    vi.useFakeTimers();
    let storedQueue: IPriwaQueuedMutation[] = [
      {
        ...interruptedMutation,
        retryCount: 0,
        status: "pending" as const,
      },
    ];
    mocks.loadQueue.mockImplementation(async () => storedQueue);
    mocks.saveQueue.mockImplementation(
      async (
        _projectId: string,
        _userId: string,
        queue: IPriwaQueuedMutation[],
      ) => {
        storedQueue = queue;
      },
    );
    let confirmRequestStarted: () => void = () => undefined;
    const requestStarted = new Promise<void>((resolve) => {
      confirmRequestStarted = resolve;
    });
    mocks.upsertPoint.mockImplementation(
      async (_projectId: string, _point: IPriwaPoint, signal: AbortSignal) => {
        confirmRequestStarted();
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        });
      },
    );
    const { usePriwaSyncQueueRunner } =
      await import("./usePriwaSyncQueueRunner");
    const runner = usePriwaSyncQueueRunner({
      projectId: "project-1",
      userId: "user-1",
      isOnline: true,
      onQueueUpdated: vi.fn(),
      onPointSynced: vi.fn(),
      onPointDeleted: vi.fn(),
      onQueueDrained: vi.fn().mockResolvedValue(undefined),
    });

    const syncResult = runner.syncQueue();
    await requestStarted;
    expect(mocks.upsertPoint).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(PRIWA_SYNC_REQUEST_TIMEOUT_MS);
    await syncResult;

    expect(storedQueue).toEqual([
      expect.objectContaining({
        pointId: "point-1",
        retryCount: 1,
        status: "failed",
        lastError: "PRIWA-Synchronisation hat zu lange gedauert.",
      }),
    ]);
  });
});
