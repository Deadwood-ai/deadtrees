import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { addIds, readStoredSelection, removeIds, toggleId, writeStoredSelection } from "./factorySelection";

interface FactorySelectionValue {
	selectedIds: number[];
	isSelected: (id: number) => boolean;
	select: (ids: number[]) => void;
	deselect: (ids: number[]) => void;
	toggle: (id: number) => void;
	clear: () => void;
}

const FactorySelectionContext = createContext<FactorySelectionValue | null>(null);

const storage = () => (typeof window !== "undefined" ? window.sessionStorage : undefined);

/** Dataset selection that survives paging, filtering and detail visits inside the workspace. */
export function FactorySelectionProvider({ children }: { children: ReactNode }) {
	const [selectedIds, setSelectedIds] = useState<number[]>(() => readStoredSelection(storage()));

	useEffect(() => {
		writeStoredSelection(storage(), selectedIds);
	}, [selectedIds]);

	const value = useMemo<FactorySelectionValue>(() => {
		const selectedSet = new Set(selectedIds);
		return {
			selectedIds,
			isSelected: (id) => selectedSet.has(id),
			select: (ids) => setSelectedIds((current) => addIds(current, ids)),
			deselect: (ids) => setSelectedIds((current) => removeIds(current, ids)),
			toggle: (id) => setSelectedIds((current) => toggleId(current, id)),
			clear: () => setSelectedIds([]),
		};
	}, [selectedIds]);

	return <FactorySelectionContext.Provider value={value}>{children}</FactorySelectionContext.Provider>;
}

export function useFactorySelection(): FactorySelectionValue {
	const value = useContext(FactorySelectionContext);
	if (!value) {
		throw new Error("useFactorySelection must be used inside FactorySelectionProvider");
	}
	return value;
}

/** Stable callback for copying text, with a graceful fallback message when the clipboard is unavailable. */
export function useCopyToClipboard() {
	return useCallback(async (text: string): Promise<boolean> => {
		try {
			if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(text);
				return true;
			}
		} catch {
			// fall through to the failure result
		}
		return false;
	}, []);
}
