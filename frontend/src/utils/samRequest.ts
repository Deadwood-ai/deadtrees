import { Settings } from "../config";

// The hosted model can take minutes to start after a pause. Modal answers requests that run
// longer than 150 s with a redirect the browser cannot follow, so give up well before that.
export const SAM_REQUEST_TIMEOUT_MS = 90_000;
// A warm-up keeps the model awake while someone labels; repeat it at most this often.
export const SAM_WARMUP_INTERVAL_MS = 45_000;

export const SAM_STARTING_MESSAGE =
  "The AI model is still starting up, which can take a few minutes after a pause. Please try again shortly.";
export const SAM_UNREACHABLE_MESSAGE = "The AI segmentation service could not be reached. Please try again later.";

let lastWarmUpAt = 0;

/** Posts a segmentation request and turns timeouts and network failures into readable errors. */
export async function requestSegmentation(form: FormData, timeoutMs = SAM_REQUEST_TIMEOUT_MS): Promise<unknown> {
  const response = await fetch(`${Settings.SAM_API_URL}/segment`, {
    method: "POST",
    mode: "cors",
    headers: { Accept: "application/json" },
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((e: unknown) => (isTimeout(e) ? SAM_STARTING_MESSAGE : SAM_UNREACHABLE_MESSAGE));
  if (typeof response === "string") {
    throw new Error(response);
  }
  if (!response.ok) {
    throw new Error(`AI segmentation failed (${response.status}). Please try again.`);
  }
  lastWarmUpAt = Date.now();
  return response.json();
}

/**
 * Starts the model in the background so it is ready by the time the user has drawn a box.
 * Throttled, fire-and-forget; failures are ignored because the real request reports them.
 */
export function warmUpSegmentation(now = Date.now()): boolean {
  if (now - lastWarmUpAt < SAM_WARMUP_INTERVAL_MS) return false;
  lastWarmUpAt = now;
  const form = new FormData();
  form.append("image", new File([TINY_JPEG], "warmup.jpg", { type: "image/jpeg" }));
  form.append("bboxes", JSON.stringify([0, 0, 1, 1]));
  form.append("labels", JSON.stringify([1]));
  void requestSegmentation(form, SAM_REQUEST_TIMEOUT_MS).catch(() => undefined);
  return true;
}

function isTimeout(e: unknown): boolean {
  return e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
}

export function resetSamWarmUpForTests() {
  lastWarmUpAt = 0;
}

// 16x16 grey JPEG, small enough to start the model without real work.
const TINY_JPEG = Uint8Array.from(
  atob(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAQABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCvRRRWRJ//2Q==",
  ),
  (c) => c.charCodeAt(0),
);
