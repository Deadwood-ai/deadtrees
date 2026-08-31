const inProcessSyncLocks = new Map<string, Promise<void>>();

const runWithInProcessLock = async <T>(
  lockName: string,
  task: () => Promise<T>,
): Promise<T> => {
  const previousTask = inProcessSyncLocks.get(lockName) ?? Promise.resolve();
  let releaseLock: () => void = () => undefined;
  const currentTask = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const lockTail = previousTask.catch(() => undefined).then(() => currentTask);
  inProcessSyncLocks.set(lockName, lockTail);

  await previousTask.catch(() => undefined);
  try {
    return await task();
  } finally {
    releaseLock();
    if (inProcessSyncLocks.get(lockName) === lockTail) {
      inProcessSyncLocks.delete(lockName);
    }
  }
};

export const runWithPriwaSyncLock = async <T>(
  projectId: string,
  userId: string,
  task: () => Promise<T>,
): Promise<T> => {
  const lockName = `priwa-sync:${projectId}:${userId}`;

  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(lockName, task);
  }

  return runWithInProcessLock(lockName, task);
};
