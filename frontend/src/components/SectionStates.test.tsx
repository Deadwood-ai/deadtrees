// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  InlineEmpty,
  InlineLoadError,
  InlineSkeleton,
  ListSkeleton,
  SLOW_LOADING_MESSAGE,
  SectionLoadError,
  SectionSkeleton,
  TableSkeleton,
} from "./SectionStates";
import { MapPageSkeleton, MapSkeleton, PageSkeleton } from "./PageSkeletons";
import { SLOW_LOADING_AFTER_MS } from "../hooks/useSlowLoading";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const skeletons = [
  ["page", <PageSkeleton label="Loading page" />],
  ["map page", <MapPageSkeleton label="Loading page" />],
  ["map", <MapSkeleton label="Loading page" />],
  ["section", <SectionSkeleton label="Loading page" />],
  ["table", <TableSkeleton label="Loading page" />],
  ["list", <ListSkeleton label="Loading page" />],
] as const;

describe("loading states", () => {
  it.each(skeletons)("the %s skeleton is announced to screen readers without visible loading text", (_, element) => {
    render(element);
    expect(screen.getByRole("status", { name: "Loading page" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/loading/i);
  });

  it.each(skeletons)("the %s skeleton explains a wait once it passes eight seconds", (_, element) => {
    vi.useFakeTimers();
    render(element);
    expect(screen.queryByText(SLOW_LOADING_MESSAGE)).toBeNull();
    act(() => vi.advanceTimersByTime(SLOW_LOADING_AFTER_MS));
    expect(screen.getByText(SLOW_LOADING_MESSAGE)).toBeTruthy();
  });

  it("an inline value shows one labelled bar", () => {
    render(<InlineSkeleton label="Loading the dataset count" />);
    const bar = screen.getByRole("status", { name: "Loading the dataset count" });
    expect(bar.textContent).toBe("");
    expect(bar.className).toContain("motion-reduce:animate-none");
  });
});

describe("failed and empty states", () => {
  it("a failed section names what is missing and retries in place", () => {
    const onRetry = vi.fn();
    render(<SectionLoadError title="The downloads couldn’t load" onRetry={onRetry} />);
    expect(screen.getByRole("heading", { name: "The downloads couldn’t load" })).toBeTruthy();
    expect(screen.getByText("DeadTrees didn’t respond. Check your connection and try again.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("a failed section can carry the reason instead of the generic sentence", () => {
    render(<SectionLoadError title="Processors couldn’t load" description="timeout after 30 s" onRetry={() => {}} />);
    expect(screen.getByText("timeout after 30 s")).toBeTruthy();
    expect(screen.queryByText(/didn’t respond/)).toBeNull();
  });

  it("a failed inline value offers a retry link", () => {
    const onRetry = vi.fn();
    render(<InlineLoadError message="Review details couldn’t load." onRetry={onRetry} />);
    expect(screen.getByRole("alert").textContent).toContain("Review details couldn’t load.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("an empty inline panel is a quiet note", () => {
    render(<InlineEmpty>No patches placed yet.</InlineEmpty>);
    expect(screen.getByText("No patches placed yet.").tagName).toBe("P");
  });
});
