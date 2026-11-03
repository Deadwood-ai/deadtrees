import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ token: "session-token" as string | null }));
vi.mock("../hooks/useSupabase", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: session.token ? { access_token: session.token } : null } }),
    },
  },
}));
import {
  requestConcepts,
  requestSegmentation,
  resetSamWarmUpForTests,
  SAM_STARTING_MESSAGE,
  SAM_UNREACHABLE_MESSAGE,
  SAM_WARMUP_INTERVAL_MS,
  warmUpSegmentation,
} from "./samRequest";

const fetchMock = vi.fn();
const prompt = { image: new Blob(["x"]), box: [1, 2, 3, 4] };

beforeEach(() => {
  resetSamWarmUpForTests();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestSegmentation", () => {
  it("returns the parsed response", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ type: "FeatureCollection", features: [] })));
    await expect(requestSegmentation(prompt)).resolves.toEqual({ type: "FeatureCollection", features: [] });
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("explains a timeout as a model that is still starting", async () => {
    fetchMock.mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    await expect(requestSegmentation(prompt)).rejects.toThrow(SAM_STARTING_MESSAGE);
  });

  it("explains a network failure as an unreachable service", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(requestSegmentation(prompt)).rejects.toThrow(SAM_UNREACHABLE_MESSAGE);
  });

  it("reports an HTTP error status", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 500 }));
    await expect(requestSegmentation(prompt)).rejects.toThrow("AI segmentation failed (500)");
  });
});

describe("request forms", () => {
  it("sends box, clicks and labels for a refined segmentation", async () => {
    fetchMock.mockResolvedValue(new Response("{}"));
    await requestSegmentation({ ...prompt, points: [[5, 6], [7, 8]], labels: [1, 0] });
    const [url, init] = fetchMock.mock.calls[0];
    const form = init.body as FormData;
    expect(url).toMatch(/\/segment$/);
    expect(form.get("bboxes")).toBe("[1,2,3,4]");
    expect(form.get("points")).toBe("[[5,6],[7,8]]");
    expect(form.get("labels")).toBe("[1,0]");
  });

  it("sends the text for a concept search", async () => {
    fetchMock.mockResolvedValue(new Response("{}"));
    await requestConcepts(new Blob(["x"]), "tree");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/concepts$/);
    expect((init.body as FormData).get("text")).toBe("tree");
    expect((init.body as FormData).get("threshold")).toBe("0.1");
  });
});

describe("authorization", () => {
  it("sends the session token to the SAM route of our own API", async () => {
    fetchMock.mockResolvedValue(new Response("{}"));
    await requestSegmentation(prompt);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer session-token");
  });

  it("asks to sign in again when the API refuses the session", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 401 }));
    await expect(requestSegmentation(prompt)).rejects.toThrow("Please sign in again");
  });
});

describe("warmUpSegmentation", () => {
  it("sends one warm-up per interval", async () => {
    fetchMock.mockReturnValue(new Promise(() => undefined));
    expect(warmUpSegmentation(1_000_000)).toBe(true);
    expect(warmUpSegmentation(1_000_000 + SAM_WARMUP_INTERVAL_MS - 1)).toBe(false);
    expect(warmUpSegmentation(1_000_000 + SAM_WARMUP_INTERVAL_MS)).toBe(true);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
