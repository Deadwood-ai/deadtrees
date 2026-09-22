import { beforeEach, describe, expect, it, vi } from "vitest";

import type { IPriwaQueuedMutation } from "./priwaOfflineStore";
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

vi.mock("./syncPriwaObservation", () => ({
  syncPriwaObservation: mocks.upsertPoint,
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
    const onSyncFinished = vi.fn().mockResolvedValue(undefined);
    const { usePriwaSyncQueueRunner } =
      await import("./usePriwaSyncQueueRunner");
    const runner = usePriwaSyncQueueRunner({
      projectId: "project-1",
      userId: "user-1",
      isOnline: true,
      onQueueUpdated: vi.fn(),
      onPointSynced: vi.fn(),
      onPointDeleted: vi.fn(),
      onSyncFinished,
    });

    await runner.syncQueue();

    expect(mocks.upsertPoint).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1", point }),
    );
    expect(storedQueue).toEqual([]);
    expect(onSyncFinished).toHaveBeenCalledOnce();
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
    const onSyncFinished = vi.fn().mockResolvedValue(undefined);
    const { usePriwaSyncQueueRunner } =
      await import("./usePriwaSyncQueueRunner");
    const runner = usePriwaSyncQueueRunner({
      projectId: "project-1",
      userId: "user-1",
      isOnline: true,
      onQueueUpdated: vi.fn(),
      onPointSynced: vi.fn(),
      onPointDeleted: vi.fn(),
      onSyncFinished,
    });

    await runner.syncQueue();

    expect(mocks.upsertPoint).not.toHaveBeenCalled();
    expect(storedQueue).toEqual([]);
    expect(onSyncFinished).toHaveBeenCalledOnce();
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
      async (mutation: IPriwaQueuedMutation) => {
        const nextPoint = mutation.point!;
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
        onSyncFinished: vi.fn().mockResolvedValue(undefined),
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
    expect(
      mocks.upsertPoint.mock.calls.map((call) => call[0].point.baumnr),
    ).toEqual(["old", "newer"]);
    expect(storedQueue).toEqual([]);
  });
  it("keeps a failed edit while syncing later independent observations", async () => {
    const failed = {
      ...interruptedMutation,
      type: "update" as const,
      status: "pending" as const,
    };
    const valid = {
      ...interruptedMutation,
      id: "p2",
      pointId: "p2",
      point: { ...point, id: "p2" },
      status: "pending" as const,
    };
    let storedQueue: IPriwaQueuedMutation[] = [failed, valid];
    mocks.loadQueue.mockImplementation(async () => storedQueue);
    mocks.saveQueue.mockImplementation(
      async (
        _project: string,
        _user: string,
        queue: IPriwaQueuedMutation[],
      ) => {
        storedQueue = queue;
      },
    );
    mocks.upsertPoint.mockImplementation(
      async (mutation: IPriwaQueuedMutation) => {
        if (mutation.pointId === failed.pointId)
          throw new Error("Revision conflict");
        return "2026-05-19T08:05:00.000Z";
      },
    );
    const onSyncFinished = vi.fn().mockResolvedValue(undefined);
    const { usePriwaSyncQueueRunner } =
      await import("./usePriwaSyncQueueRunner");
    const runner = usePriwaSyncQueueRunner({
      projectId: "project-1",
      userId: "user-1",
      isOnline: true,
      onQueueUpdated: vi.fn(),
      onPointSynced: vi.fn(),
      onPointDeleted: vi.fn(),
      onSyncFinished,
    });
    await runner.syncQueue();
    expect(mocks.upsertPoint).toHaveBeenCalledTimes(2);
    expect(storedQueue).toEqual([
      expect.objectContaining({
        pointId: failed.pointId,
        status: "failed",
        lastError: "Revision conflict",
      }),
    ]);
    expect(onSyncFinished).toHaveBeenCalledOnce();
  });
});
