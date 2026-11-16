// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_OPACITY, OPACITY_KEY, usePredictionOpacity } from "./usePredictionOpacity";

afterEach(() => {
	window.localStorage.clear();
	vi.restoreAllMocks();
});

describe("usePredictionOpacity", () => {
	it("starts at 60% and remembers a change for the next crop review", () => {
		const { result } = renderHook(() => usePredictionOpacity());
		expect(result.current.opacity).toBe(DEFAULT_OPACITY);
		act(() => result.current.setOpacity(0.3));
		expect(window.localStorage.getItem(OPACITY_KEY)).toBe("0.3");
		expect(renderHook(() => usePredictionOpacity()).result.current.opacity).toBe(0.3);
	});

	it("steps by 20% and stays between raw only and the prediction alone", () => {
		window.localStorage.setItem(OPACITY_KEY, "0.9");
		const { result } = renderHook(() => usePredictionOpacity());
		act(() => result.current.stronger());
		expect(result.current.opacity).toBe(1);
		act(() => result.current.setOpacity(0.1));
		act(() => result.current.weaker());
		expect(result.current.opacity).toBe(0);
	});

	it("ignores a stored value that is not an opacity", () => {
		for (const bad of ["", "abc", "1.5", "-1"]) {
			window.localStorage.setItem(OPACITY_KEY, bad);
			expect(renderHook(() => usePredictionOpacity()).result.current.opacity).toBe(DEFAULT_OPACITY);
		}
	});

	it("works when the browser blocks storage", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		const { result } = renderHook(() => usePredictionOpacity());
		expect(result.current.opacity).toBe(DEFAULT_OPACITY);
		act(() => result.current.setOpacity(0.4));
		expect(result.current.opacity).toBe(0.4);
	});
});
