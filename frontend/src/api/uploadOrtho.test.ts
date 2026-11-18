import { createHash } from "node:crypto";
import { AxiosError, AxiosHeaders } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
vi.mock("axios", async (importOriginal) => {
  const actual = await importOriginal<typeof import("axios")>();
  return { ...actual, default: { ...actual.default, get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) } };
});
vi.mock("../config", () => ({ Settings: { API_URL: "http://api.test", API_URL_UPLOAD_ENDPOINT: "http://api.test/datasets/chunk" } }));

import {
  transferUpload,
  UploadFileMismatchError,
  UploadNotResumableError,
  UploadRejectedError,
  type TransferEvent,
  type UploadStatus,
} from "./uploadOrtho";

const CHUNK = 4;
const bytes = "aaaabbbbccccdd"; // 4 chunks: aaaa bbbb cccc dd
const file = new File([bytes], "flight.zip", { lastModified: 1 });
const metadata = { license: "CC BY", platform: "drone", authors: ["A"], upload_type: "raw_images_zip" };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const httpError = (status?: number, detail: unknown = "error") => {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError(
    "failed",
    status ? "ERR_BAD_RESPONSE" : "ERR_NETWORK",
    config,
    undefined,
    status ? { status, data: { detail }, statusText: "", headers: {}, config } : undefined,
  );
};

const status = (overrides: Partial<UploadStatus>): UploadStatus => ({
  upload_id: "up-1",
  state: "receiving",
  chunks_total: 4,
  chunks_received: 0,
  bytes_received: 0,
  last_chunk: null,
  contract: null,
  response: null,
  created_at: 1,
  updated_at: 2,
  ...overrides,
});

const received = (parts: string[]) => {
  const chunks = parts.map((part) => ({ size: part.length, sha256: sha(part) }));
  return status({
    chunks_received: parts.length,
    bytes_received: parts.join("").length,
    last_chunk: chunks[chunks.length - 1],
    chunks,
  });
};

const sentChunks = () => post.mock.calls.map(([, form]) => Number((form as FormData).get("chunk_index")));

async function run(extra: Partial<Parameters<typeof transferUpload>[0]> = {}) {
  const events: TransferEvent[] = [];
  const getAccessToken = vi.fn(async (refresh?: boolean) => (refresh ? "fresh" : "token"));
  const promise = transferUpload({
    file,
    uploadId: "up-1",
    metadata,
    chunkSize: CHUNK,
    getAccessToken,
    onProgress: () => undefined,
    onEvent: (event) => events.push(event),
    ...extra,
  });
  promise.catch(() => undefined);
  await vi.runAllTimersAsync();
  return { promise, events, getAccessToken };
}

describe("resumable chunk upload", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    post.mockImplementation(async (_url, form: FormData) =>
      form.get("chunk_index") === "3" ? { data: { id: "42" } } : { data: { message: "ok" } },
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    get.mockReset();
    post.mockReset();
  });

  it("sends every chunk of a new upload in order", async () => {
    get.mockRejectedValue(httpError(404));
    const { promise } = await run();
    await expect(promise).resolves.toEqual({ id: "42" });
    expect(sentChunks()).toEqual([0, 1, 2, 3]);
    const form = post.mock.calls[0][1] as FormData;
    expect([form.get("upload_id"), form.get("chunks_total"), form.get("license")]).toEqual(["up-1", "4", "CC BY"]);
  });

  it("sends three chunks at once and declares the chunk size", async () => {
    get.mockRejectedValue(httpError(404));
    let inFlight = 0;
    let most = 0;
    post.mockImplementation(async (_url, form: FormData) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 100));
      inFlight--;
      expect(form.get("chunk_size")).toBe(String(CHUNK));
      return form.get("chunk_index") === "3" ? { data: { id: "42" } } : { data: {} };
    });
    const { promise } = await run();
    await expect(promise).resolves.toEqual({ id: "42" });
    expect(most).toBe(3);
  });

  it("finds the dataset when another chunk than the last completed the upload", async () => {
    get.mockRejectedValueOnce(httpError(404)).mockResolvedValueOnce({ data: status({ state: "complete", response: { id: "9" } }) });
    post.mockResolvedValue({ data: {} });
    const { promise } = await run();
    await expect(promise).resolves.toEqual({ id: "9" });
  });

  it("continues an upload started before parallel sending in order, without a chunk size", async () => {
    get.mockResolvedValue({ data: { ...received(["aaaa"]), contract: { file_name: "flight.zip" } } });
    post.mockImplementation(async (_url, form: FormData) => {
      expect(form.get("chunk_size")).toBeNull();
      return form.get("chunk_index") === "3" ? { data: { id: "42" } } : { data: {} };
    });
    const { promise } = await run();
    await expect(promise).resolves.toEqual({ id: "42" });
    expect(sentChunks()).toEqual([1, 2, 3]);
  });

  it("sends only the chunks missing in the middle of a parallel upload", async () => {
    const parts = ["aaaa", null, "cccc", null];
    const chunks = parts.map((part) => (part ? { size: part.length, sha256: sha(part) } : null));
    get.mockResolvedValue({
      data: status({ chunks_received: 2, bytes_received: 8, chunks, contract: { chunk_size: CHUNK } }),
    });
    const { promise } = await run();
    await expect(promise).resolves.toEqual({ id: "42" });
    expect(sentChunks().sort()).toEqual([1, 3]);
  });

  it("does not ask the server about a brand-new upload ID", async () => {
    const { promise } = await run({ isNew: true });
    await expect(promise).resolves.toEqual({ id: "42" });
    expect(get).not.toHaveBeenCalled();
    expect(sentChunks()).toEqual([0, 1, 2, 3]);
  });

  it("continues after the chunks the server holds, once the last one matches the file", async () => {
    get.mockResolvedValue({ data: received(["aaaa", "bbbb"]) });
    const { promise, events } = await run();
    await expect(promise).resolves.toEqual({ id: "42" });
    expect(sentChunks()).toEqual([2, 3]);
    expect(events).toContainEqual({ type: "resumed", chunkIndex: 2, chunksTotal: 4 });
  });

  it("refuses a different file without sending anything", async () => {
    get.mockResolvedValue({ data: received(["aaaa", "xxxx"]) });
    const { promise } = await run();
    await expect(promise).rejects.toBeInstanceOf(UploadFileMismatchError);
    expect(post).not.toHaveBeenCalled();
  });

  it("refuses a file whose earlier chunks differ, even when the last received one matches", async () => {
    get.mockResolvedValue({ data: received(["xxxx", "bbbb"]) });
    const { promise } = await run();
    await expect(promise).rejects.toBeInstanceOf(UploadFileMismatchError);
    expect(post).not.toHaveBeenCalled();
  });

  it("resends the last chunk when every chunk arrived but the reply was lost", async () => {
    get.mockResolvedValue({ data: received(["aaaa", "bbbb", "cccc", "dd"]) });
    const { promise } = await run();
    await expect(promise).resolves.toEqual({ id: "42" });
    expect(sentChunks()).toEqual([3]);
  });

  it("returns a finished upload's dataset without sending", async () => {
    get.mockResolvedValue({ data: status({ state: "complete", chunks_received: 4, response: { id: "7" } }) });
    const { promise } = await run();
    await expect(promise).resolves.toEqual({ id: "7" });
    expect(post).not.toHaveBeenCalled();
  });

  it.each(["expired", "finalizing"] as const)("stops on an upload that is %s", async (state) => {
    get.mockResolvedValue({ data: { ...received(["aaaa"]), state } });
    const { promise } = await run();
    await expect(promise).rejects.toBeInstanceOf(UploadNotResumableError);
  });

  it("keeps retrying a chunk through a network outage and reports the stall once", async () => {
    get.mockRejectedValue(httpError(404));
    let failures = 4;
    post.mockImplementation(async (_url, form: FormData) => {
      if (form.get("chunk_index") === "1" && failures-- > 0) throw httpError();
      return form.get("chunk_index") === "3" ? { data: { id: "42" } } : { data: {} };
    });
    const { promise, events } = await run();
    await expect(promise).resolves.toEqual({ id: "42" });
    expect(sentChunks().sort()).toEqual([0, 1, 1, 1, 1, 1, 2, 3]);
    expect(events.filter((event) => event.type === "chunk_failed")).toHaveLength(4);
    expect(events.filter((event) => event.type === "stalled")).toHaveLength(1);
    expect(events).toContainEqual({ type: "recovered", chunkIndex: 1, chunksTotal: 4 });
  });

  it("drops a chunk request that sends nothing for two minutes and tries again", async () => {
    get.mockRejectedValue(httpError(404));
    let hung = false;
    post.mockImplementation((_url, form: FormData, config: { signal: AbortSignal }) => {
      if (form.get("chunk_index") === "0" && !hung) {
        hung = true;
        return new Promise((_resolve, reject) =>
          config.signal.addEventListener("abort", () => reject(new AxiosError("canceled", "ERR_CANCELED"))),
        );
      }
      return Promise.resolve(form.get("chunk_index") === "3" ? { data: { id: "42" } } : { data: {} });
    });
    const { promise, events } = await run();
    await expect(promise).resolves.toEqual({ id: "42" });
    expect(sentChunks().sort()).toEqual([0, 0, 1, 2, 3]);
    expect(events).toContainEqual({ type: "chunk_failed", chunkIndex: 0, chunksTotal: 4, attempt: 1, reason: "no_progress" });
  });

  it("refreshes the login after the API rejects the token", async () => {
    get.mockRejectedValue(httpError(404));
    const tokens: string[] = [];
    post.mockImplementation(async (_url, form: FormData, config: { headers: Record<string, string> }) => {
      if (form.get("chunk_index") === "0") tokens.push(config.headers.Authorization);
      if (tokens.length === 1 && form.get("chunk_index") === "0") throw httpError(401, "Invalid token");
      return form.get("chunk_index") === "3" ? { data: { id: "42" } } : { data: {} };
    });
    const { promise, getAccessToken } = await run();
    await expect(promise).resolves.toEqual({ id: "42" });
    expect(getAccessToken).toHaveBeenCalledWith(true);
    expect(tokens).toEqual(["Bearer token", "Bearer fresh"]);
  });

  it("stops when cancelled during the pause between retries", async () => {
    get.mockRejectedValue(httpError(404));
    post.mockRejectedValue(httpError());
    const controller = new AbortController();
    const events: TransferEvent[] = [];
    const promise = transferUpload({
      file,
      uploadId: "up-1",
      metadata,
      chunkSize: CHUNK,
      getAccessToken: async () => "token",
      onProgress: () => undefined,
      onEvent: (event) => {
        events.push(event);
        // Cancel 0.1 s into the 2 s pause before the next try.
        setTimeout(() => controller.abort(), 100);
      },
      signal: controller.signal,
    });
    promise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(10_000);
    // The first round of parallel chunks went out; none was tried again.
    expect(new Set(sentChunks()).size).toBe(sentChunks().length);
  });

  it("gives up on an upload ID the server no longer accepts", async () => {
    get.mockRejectedValue(httpError(404));
    post.mockRejectedValue(httpError(409, "Upload has no retry receipts; restart with a new upload ID"));
    const { promise } = await run();
    await expect(promise).rejects.toBeInstanceOf(UploadNotResumableError);
    expect(new Set(sentChunks()).size).toBe(sentChunks().length);
  });

  it("retries a status read that hits a short outage", async () => {
    get.mockRejectedValueOnce(httpError()).mockRejectedValueOnce(httpError(404));
    const { promise } = await run();
    await expect(promise).resolves.toEqual({ id: "42" });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("stops at once when the API refuses the file", async () => {
    get.mockRejectedValue(httpError(404));
    post.mockRejectedValue(httpError(400, "This ZIP contains no drone photos"));
    const { promise } = await run();
    await expect(promise).rejects.toBeInstanceOf(UploadRejectedError);
    expect(new Set(sentChunks()).size).toBe(sentChunks().length);
    expect(sentChunks()).not.toContain(3);
  });
});
