import {
  loadPriwaSyncQueue,
  savePriwaSyncQueue,
  type IPriwaQueuedMutation,
} from "./priwaOfflineStore";
import { runWithPriwaQueueLock } from "./priwaSyncLock";

type PriwaQueueUpdater = (
  queue: IPriwaQueuedMutation[],
) => IPriwaQueuedMutation[];

export const updatePriwaSyncQueue = async (
  projectId: string,
  userId: string,
  updater: PriwaQueueUpdater,
  onUpdated?: (queue: IPriwaQueuedMutation[]) => void,
) => {
  return runWithPriwaQueueLock(projectId, userId, async () => {
    const currentQueue = await loadPriwaSyncQueue(projectId, userId);
    const nextQueue = updater(currentQueue);
    await savePriwaSyncQueue(projectId, userId, nextQueue);
    onUpdated?.(nextQueue);
    return nextQueue;
  });
};
