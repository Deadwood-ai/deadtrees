import { afterEach, describe, expect, it, vi } from "vitest";

import { runPriwaSyncRequest } from "./priwaSyncRequest";

describe("PRIWA sync queue requests", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts and rejects a request that exceeds the sync timeout", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const request = vi.fn((signal: AbortSignal) => {
      requestSignal = signal;
      return new Promise<void>(() => undefined);
    });

    const result = runPriwaSyncRequest(request, 1_000);
    const rejection = expect(result).rejects.toThrow(
      "PRIWA-Synchronisation hat zu lange gedauert.",
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
    expect(request).toHaveBeenCalledOnce();
    expect(requestSignal?.aborted).toBe(true);
  });
});
