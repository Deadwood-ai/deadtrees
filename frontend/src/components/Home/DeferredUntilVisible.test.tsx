// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeferredVideo } from "./DeferredUntilVisible";

let onIntersect: IntersectionObserverCallback;

beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        onIntersect = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DeferredVideo", () => {
  it("reserves the video's shape and loads nothing until it is near the viewport", () => {
    const { container } = render(
      <DeferredVideo src="/clip.mp4" width={1188} height={720} />,
    );

    expect(container.querySelector("video")).toBeNull();
    expect((container.firstChild as HTMLElement).style.aspectRatio).toBe("1188 / 720");

    act(() =>
      onIntersect(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    );

    expect(container.querySelector("video")?.getAttribute("src")).toBe("/clip.mp4");
  });
});
