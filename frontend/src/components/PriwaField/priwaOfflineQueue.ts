import {
  loadPriwaSyncQueue,
  savePriwaSyncQueue,
  type IPriwaQueuedMutation,
} from "./priwaOfflineStore";

type PriwaQueueUpdater = (
  queue: IPriwaQueuedMutation[],
) => IPriwaQueuedMutation[];

let queueTransaction = Promise.resolve();

export const updatePriwaSyncQueue = async (
  projectId: string,
  userId: string,
  updater: PriwaQueueUpdater,
  onUpdated?: (queue: IPriwaQueuedMutation[]) => void,
) => {
  const transaction = queueTransaction
    .catch(() => undefined)
    .then(async () => {
      const currentQueue = await loadPriwaSyncQueue(projectId, userId);
      const nextQueue = updater(currentQueue);
      await savePriwaSyncQueue(projectId, userId, nextQueue);
      onUpdated?.(nextQueue);
      return nextQueue;
    });

  queueTransaction = transaction.then(
    () => undefined,
    () => undefined,
  );

  return transaction;
};
