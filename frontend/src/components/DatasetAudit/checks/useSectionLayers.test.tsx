// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { DatasetDetailsMapProvider, useDatasetDetailsMap } from "../../../hooks/useDatasetDetailsMapProvider";
import type { ISectionLayers } from "../../../utils/auditChecks";
import { useSectionLayers } from "./useSectionLayers";

const wrapper = ({ children }: { children: ReactNode }) => <DatasetDetailsMapProvider>{children}</DatasetDetailsMapProvider>;

function useLayers(shows: ISectionLayers | null) {
	useSectionLayers(shows);
	return useDatasetDetailsMap();
}

const shown = (layers: ReturnType<typeof useDatasetDetailsMap>) => {
	const { showAOI, showDeadwood, showForestCover } = layers.layerControl;
	return { showAOI, showDeadwood, showForestCover };
};

const ORTHO = { aoi: false, deadwood: false, forestCover: false };
const ALL = { aoi: true, deadwood: true, forestCover: true };

describe("useSectionLayers", () => {
	it("shows only the orthophoto while such a step is open and brings the layers back", () => {
		const { result, rerender } = renderHook(({ shows }) => useLayers(shows), { wrapper, initialProps: { shows: null as ISectionLayers | null } });
		const before = shown(result.current);
		rerender({ shows: ORTHO });
		expect(shown(result.current)).toEqual({ showAOI: false, showDeadwood: false, showForestCover: false });
		rerender({ shows: null });
		expect(shown(result.current)).toEqual(before);
	});

	it("switches the predictions on for a step that needs them", () => {
		const { result, rerender } = renderHook(({ shows }) => useLayers(shows), { wrapper, initialProps: { shows: null as ISectionLayers | null } });
		act(() => result.current.setShowDeadwood(false));
		rerender({ shows: ALL });
		expect(shown(result.current)).toEqual({ showAOI: true, showDeadwood: true, showForestCover: true });
		rerender({ shows: null });
		expect(shown(result.current).showDeadwood).toBe(false);
	});

	it("keeps a layer the reviewer switched meanwhile", () => {
		const { result, rerender } = renderHook(({ shows }) => useLayers(shows), { wrapper, initialProps: { shows: null as ISectionLayers | null } });
		act(() => result.current.setShowDeadwood(false));
		rerender({ shows: ORTHO });
		act(() => result.current.setShowDeadwood(true));
		rerender({ shows: null });
		expect(shown(result.current).showDeadwood).toBe(true);
	});

	it("shows one prediction layer at a time for its step", () => {
		const { result, rerender } = renderHook(({ shows }) => useLayers(shows), { wrapper, initialProps: { shows: null as ISectionLayers | null } });
		rerender({ shows: { aoi: true, deadwood: true, forestCover: false } });
		expect(shown(result.current)).toEqual({ showAOI: true, showDeadwood: true, showForestCover: false });
	});
});
