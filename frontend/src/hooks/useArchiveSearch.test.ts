// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ARCHIVE_TEXT_SEARCH_DEBOUNCE_MS,
  useArchiveSearch,
} from "./useArchiveSearch";

// The semantic hook needs auth and React Query; only its URL-derived query
// matters to the search field.
vi.mock("./useSemanticSearch", async () => {
  const { useSearchParams } = await import("react-router-dom");
  return {
    useSemanticSearch: (enabled: boolean) => {
      const [params] = useSearchParams();
      return { query: enabled ? params.get("q") : null };
    },
  };
});

const renderSearch = (initialUrl = "/dataset") =>
  renderHook(
    () => ({
      search: useArchiveSearch(),
      location: useLocation(),
      navigate: useNavigate(),
    }),
    {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(MemoryRouter, { initialEntries: [initialUrl] }, children),
    },
  );

const waitForDebounce = () =>
  act(() => {
    vi.advanceTimersByTime(ARCHIVE_TEXT_SEARCH_DEBOUNCE_MS);
  });

describe("useArchiveSearch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows every keystroke at once and writes the URL after the debounce", () => {
    const { result } = renderSearch();
    const typed = "Freiburg im Breisgau";

    for (let length = 1; length <= typed.length; length += 1) {
      act(() => result.current.search.changeInput(typed.slice(0, length)));
      expect(result.current.search.input).toBe(typed.slice(0, length));
    }
    expect(result.current.search.text).toBe("");
    expect(result.current.location.search).toBe("");

    waitForDebounce();
    expect(result.current.search.input).toBe(typed);
    expect(result.current.search.text).toBe(typed);
    expect(result.current.location.search).toBe("?text=Freiburg+im+Breisgau");
  });

  it("keeps what was typed while an earlier URL write lands", () => {
    const { result } = renderSearch();

    act(() => result.current.search.changeInput("frei"));
    waitForDebounce();
    act(() => result.current.search.changeInput("freiburg"));
    expect(result.current.search.input).toBe("freiburg");
    expect(result.current.search.text).toBe("frei");

    waitForDebounce();
    expect(result.current.search.text).toBe("freiburg");
  });

  it("starts from a shared link and follows external URL changes", () => {
    const { result } = renderSearch("/dataset?text=cordoba");
    expect(result.current.search.input).toBe("cordoba");
    expect(result.current.search.text).toBe("cordoba");

    act(() => result.current.navigate("/dataset?text=isere"));
    expect(result.current.search.input).toBe("isere");

    act(() => result.current.navigate(-1));
    expect(result.current.search.input).toBe("cordoba");
  });

  it("clears the filter immediately when the field is cleared", () => {
    const { result } = renderSearch("/dataset?text=cordoba");

    act(() => result.current.search.changeInput(""));
    expect(result.current.search.input).toBe("");
    expect(result.current.search.text).toBe("");
    expect(result.current.location.search).toBe("");
  });

  it("drops a pending text write when the mode changes", () => {
    const { result } = renderSearch();

    act(() => result.current.search.changeInput("frei"));
    act(() => result.current.search.changeMode("ai"));
    waitForDebounce();
    expect(result.current.search.mode).toBe("ai");
    expect(result.current.search.input).toBe("");
    expect(result.current.location.search).toBe("?search=ai");

    act(() => result.current.search.changeInput("standing dead trees"));
    waitForDebounce();
    expect(result.current.search.input).toBe("standing dead trees");
    expect(result.current.location.search).toBe("?search=ai");

    act(() => result.current.search.changeMode("text"));
    expect(result.current.search.input).toBe("");
    expect(result.current.location.search).toBe("");
  });

  it("does not write the URL after the page is left", () => {
    const { result, unmount } = renderSearch();

    act(() => result.current.search.changeInput("frei"));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
