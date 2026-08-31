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
      interruptedMutation.updatedAt,
      expect.any(AbortSignal),
    );
    expect(storedQueue).toEqual([]);
    expect(onQueueDrained).toHaveBeenCalledOnce();
  });

  it("does not send a mutation removed before the atomic queue claim", async () => {
    let storedQueue: IPriwaQueuedMutation[] = [
      {
        ...interruptedMutation,
        retryCount: 0,
        status: "pending",
      },
    ];
    let saveCount = 0;
    mocks.loadQueue.mockImplementation(async () => storedQueue);
    mocks.saveQueue.mockImplementation(
      async (
        _projectId: string,
        _userId: string,
        queue: IPriwaQueuedMutation[],
      ) => {
        saveCount += 1;
        storedQueue = queue;
        if (saveCount === 1) {
          storedQueue = [];
        }
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

    expect(mocks.upsertPoint).not.toHaveBeenCalled();
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
      async (
        _projectId: string,
        _point: IPriwaPoint,
        _clientUpdatedAt: string,
        signal: AbortSignal,
      ) => {
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

  it("does not overlap a delayed write with a newer write from another runner", async () => {
    const oldPoint = { ...point, baumnr: "old" };
    const newerPoint = { ...point, baumnr: "newer" };
    let storedQueue: IPriwaQueuedMutation[] = [
      {
        ...interruptedMutation,
        point: oldPoint,
        retryCount: 0,
        status: "pending",
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
    let finishOldWrite: () => void = () => undefined;
    let confirmOldWriteStarted: () => void = () => undefined;
    const oldWriteStarted = new Promise<void>((resolve) => {
      confirmOldWriteStarted = resolve;
    });
    mocks.upsertPoint.mockImplementation(
      async (_projectId: string, nextPoint: IPriwaPoint) => {
        if (nextPoint.baumnr !== "old") return;
        confirmOldWriteStarted();
        await new Promise<void>((resolve) => {
          finishOldWrite = resolve;
        });
      },
    );
    const { usePriwaSyncQueueRunner } =
      await import("./usePriwaSyncQueueRunner");
    const useRunner = () =>
      usePriwaSyncQueueRunner({
        projectId: "project-1",
        userId: "user-1",
        isOnline: true,
        onQueueUpdated: vi.fn(),
        onPointSynced: vi.fn(),
        onPointDeleted: vi.fn(),
        onQueueDrained: vi.fn().mockResolvedValue(undefined),
      });
    const firstRunner = useRunner();
    const secondRunner = useRunner();

    const firstSync = firstRunner.syncQueue();
    await oldWriteStarted;
    storedQueue = [
      {
        ...interruptedMutation,
        point: newerPoint,
        updatedAt: "2026-05-19T08:02:00.000Z",
        status: "pending",
      },
    ];
    const secondSync = secondRunner.syncQueue();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const writesBeforeOldRequestFinished = mocks.upsertPoint.mock.calls.length;

    finishOldWrite();
    await Promise.all([firstSync, secondSync]);

    expect(writesBeforeOldRequestFinished).toBe(1);
    expect(mocks.upsertPoint.mock.calls.map((call) => call[1].baumnr)).toEqual([
      "old",
      "newer",
    ]);
    expect(storedQueue).toEqual([]);
  });
});
