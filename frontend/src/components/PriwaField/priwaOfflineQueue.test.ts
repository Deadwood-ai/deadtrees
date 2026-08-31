import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IPriwaQueuedMutation } from "./priwaOfflineStore";
import { coalescePriwaQueuedMutation } from "./priwaOfflineSync";

const storeMocks = vi.hoisted(() => ({
  loadQueue: vi.fn(),
  saveQueue: vi.fn(),
}));

vi.mock("./priwaOfflineStore", () => ({
  loadPriwaSyncQueue: storeMocks.loadQueue,
  savePriwaSyncQueue: storeMocks.saveQueue,
}));

const mutation = (pointId: string): IPriwaQueuedMutation => ({
  id: `project-1:user-1:${pointId}`,
  projectId: "project-1",
  userId: "user-1",
  pointId,
  type: "delete",
  queuedAt: "2026-05-19T08:01:00.000Z",
  updatedAt: "2026-05-19T08:01:00.000Z",
  retryCount: 0,
  status: "pending",
});

const installSharedLockManager = () => {
  const lockTails = new Map<string, Promise<void>>();
  const request = async <T>(lockName: string, task: () => Promise<T>) => {
    const previousTask = lockTails.get(lockName) ?? Promise.resolve();
    let releaseLock: () => void = () => undefined;
    const currentTask = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lockTail = previousTask.then(() => currentTask);
    lockTails.set(lockName, lockTail);

    await previousTask;
    try {
      return await task();
    } finally {
      releaseLock();
      if (lockTails.get(lockName) === lockTail) {
        lockTails.delete(lockName);
      }
    }
  };

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: { request } },
  });
};

describe("updatePriwaSyncQueue", () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    installSharedLockManager();
  });

  afterEach(() => {
    if (originalNavigator) {
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    } else {
      Reflect.deleteProperty(globalThis, "navigator");
    }
  });

  it("preserves concurrent queue updates from separate browser realms", async () => {
    let storedQueue: IPriwaQueuedMutation[] = [];
    storeMocks.loadQueue.mockImplementation(async () => {
      const snapshot = [...storedQueue];
      await new Promise((resolve) => setTimeout(resolve, 10));
      return snapshot;
    });
    storeMocks.saveQueue.mockImplementation(
      async (
        _projectId: string,
        _userId: string,
        queue: IPriwaQueuedMutation[],
      ) => {
        storedQueue = queue;
      },
    );
    const firstRealm = await import("./priwaOfflineQueue");
    vi.resetModules();
    const secondRealm = await import("./priwaOfflineQueue");

    await Promise.all([
      firstRealm.updatePriwaSyncQueue("project-1", "user-1", (queue) => [
        ...queue,
        mutation("point-1"),
      ]),
      secondRealm.updatePriwaSyncQueue("project-1", "user-1", (queue) => [
        ...queue,
        mutation("point-2"),
      ]),
    ]);

    expect(storedQueue.map((item) => item.pointId).sort()).toEqual([
      "point-1",
      "point-2",
    ]);
  });

  it("preserves a newer same-point mutation when an older realm stores later", async () => {
    let storedQueue: IPriwaQueuedMutation[] = [];
    storeMocks.loadQueue.mockImplementation(async () => [...storedQueue]);
    storeMocks.saveQueue.mockImplementation(
      async (
        _projectId: string,
        _userId: string,
        queue: IPriwaQueuedMutation[],
      ) => {
        storedQueue = queue;
      },
    );
    const olderMutation = {
      ...mutation("point-1"),
      updatedAt: "2026-05-19T08:01:00.000Z",
    };
    const newerMutation = {
      ...mutation("point-1"),
      updatedAt: "2026-05-19T08:02:00.000Z",
    };
    const firstRealm = await import("./priwaOfflineQueue");
    vi.resetModules();
    const secondRealm = await import("./priwaOfflineQueue");

    await secondRealm.updatePriwaSyncQueue(
      "project-1",
      "user-1",
      (queue) => coalescePriwaQueuedMutation(queue, newerMutation),
    );
    await firstRealm.updatePriwaSyncQueue(
      "project-1",
      "user-1",
      (queue) => coalescePriwaQueuedMutation(queue, olderMutation),
    );

    expect(storedQueue).toEqual([newerMutation]);
  });
});
