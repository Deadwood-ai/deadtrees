import { describe, expect, it } from "vitest";

import type { IPriwaPoint } from "./types";
import {
  coalescePriwaQueuedMutation,
  getPriwaSyncSummary,
  mergePriwaOfflinePoints,
} from "./priwaOfflineSync";
import type { IPriwaQueuedMutation } from "./priwaOfflineStore";

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

const mutation = (
  type: IPriwaQueuedMutation["type"],
  point: IPriwaPoint | undefined = basePoint,
): IPriwaQueuedMutation => ({
  id: `project-1:user-1:${point?.id ?? "point-1"}`,
  projectId: "project-1",
  userId: "user-1",
  pointId: point?.id ?? "point-1",
  type,
  point,
  queuedAt: "2026-05-19T08:01:00.000Z",
  updatedAt: "2026-05-19T08:01:00.000Z",
  retryCount: 0,
  status: "pending",
});

describe("PRIWA offline sync helpers", () => {
  it("coalesces create followed by update into a single create", () => {
    const editedPoint = { ...basePoint, baumnr: "43" };
    const queue = coalescePriwaQueuedMutation([], mutation("create"));
    const nextQueue = coalescePriwaQueuedMutation(
      queue,
      mutation("update", editedPoint),
    );

    expect(nextQueue).toHaveLength(1);
    expect(nextQueue[0]).toMatchObject({
      type: "create",
      point: editedPoint,
      status: "pending",
    });
  });

  it("removes local-only records when they are deleted before sync", () => {
    const queue = coalescePriwaQueuedMutation([], mutation("create"));
    const nextQueue = coalescePriwaQueuedMutation(
      queue,
      mutation("delete", undefined),
    );

    expect(nextQueue).toEqual([]);
  });

  it("overlays queued updates onto cached points", () => {
    const editedPoint = { ...basePoint, baumnr: "43" };
    const queue = [mutation("update", editedPoint)];

    expect(mergePriwaOfflinePoints([basePoint], queue)).toEqual([
      expect.objectContaining({
        id: "point-1",
        baumnr: "43",
        syncStatus: "pending",
        syncOperation: "update",
      }),
    ]);
  });

  it("summarizes queue state for the field status badge", () => {
    expect(
      getPriwaSyncSummary([
        mutation("update"),
        {
          ...mutation("create", { ...basePoint, id: "point-2" }),
          status: "failed",
        },
      ]),
    ).toEqual({
      pending: 1,
      syncing: 0,
      failed: 1,
      total: 2,
    });
  });
});
