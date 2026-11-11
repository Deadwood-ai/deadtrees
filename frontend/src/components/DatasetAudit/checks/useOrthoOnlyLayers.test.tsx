// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { DatasetDetailsMapProvider, useDatasetDetailsMap } from "../../../hooks/useDatasetDetailsMapProvider";
import { useOrthoOnlyLayers } from "./useOrthoOnlyLayers";

const wrapper = ({ children }: { children: ReactNode }) => <DatasetDetailsMapProvider>{children}</DatasetDetailsMapProvider>;

function useLayers(active: boolean) {
	useOrthoOnlyLayers(active);
	return useDatasetDetailsMap();
}

const shown = (layers: ReturnType<typeof useDatasetDetailsMap>) => {
	const { showAOI, showDeadwood, showForestCover } = layers.layerControl;
	return { showAOI, showDeadwood, showForestCover };
};

describe("useOrthoOnlyLayers", () => {
	it("hides the AOI and the predictions while the check is open and brings them back", () => {
		const { result, rerender } = renderHook(({ active }) => useLayers(active), { wrapper, initialProps: { active: false } });
		const before = shown(result.current);
		rerender({ active: true });
		expect(shown(result.current)).toEqual({ showAOI: false, showDeadwood: false, showForestCover: false });
		rerender({ active: false });
		expect(shown(result.current)).toEqual(before);
	});

	it("keeps a layer the reviewer switched on meanwhile", () => {
		const { result, rerender } = renderHook(({ active }) => useLayers(active), { wrapper, initialProps: { active: false } });
		act(() => result.current.setShowDeadwood(false));
		rerender({ active: true });
		act(() => result.current.setShowDeadwood(true));
		rerender({ active: false });
		expect(shown(result.current).showDeadwood).toBe(true);
	});
});
