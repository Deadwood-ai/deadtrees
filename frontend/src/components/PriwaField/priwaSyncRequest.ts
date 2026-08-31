export const PRIWA_SYNC_REQUEST_TIMEOUT_MS = 20_000;

const PRIWA_SYNC_TIMEOUT_MESSAGE =
  "PRIWA-Synchronisation hat zu lange gedauert.";

export const runPriwaSyncRequest = async (
  request: (signal: AbortSignal) => Promise<void>,
  timeoutMs = PRIWA_SYNC_REQUEST_TIMEOUT_MS,
) => {
  const abortController = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(PRIWA_SYNC_TIMEOUT_MESSAGE);
      abortController.abort(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    await Promise.race([request(abortController.signal), timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
};
