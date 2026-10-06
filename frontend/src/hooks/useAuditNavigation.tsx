import { createContext, useContext, useState, ReactNode, useCallback, useMemo } from "react";

interface AuditNavigationContextValue {
	filteredDatasetIds: number[];
	setFilteredDatasetIds: (ids: number[]) => void;
	getNextDatasetId: (currentId: number) => number | null;
	getPreviousDatasetId: (currentId: number) => number | null;
	currentIndex: (currentId: number) => number;
	totalCount: number;
	/** the audit list with the tab and filters the auditor came from */
	listPath: string;
	setListPath: (path: string) => void;
}

const LIST_PATH = "/dataset-audit";

const AuditNavigationContext = createContext<AuditNavigationContextValue | null>(null);

export function AuditNavigationProvider({ children }: { children: ReactNode }) {
	const [filteredDatasetIds, setFilteredDatasetIds] = useState<number[]>([]);
	const [listPath, setListPath] = useState(LIST_PATH);

	const getNextDatasetId = useCallback(
		(currentId: number): number | null => {
			const currentIndex = filteredDatasetIds.indexOf(currentId);
			if (currentIndex === -1 || currentIndex >= filteredDatasetIds.length - 1) {
				return null;
			}
			return filteredDatasetIds[currentIndex + 1];
		},
		[filteredDatasetIds]
	);

	const getPreviousDatasetId = useCallback(
		(currentId: number): number | null => {
			const currentIndex = filteredDatasetIds.indexOf(currentId);
			if (currentIndex <= 0) {
				return null;
			}
			return filteredDatasetIds[currentIndex - 1];
		},
		[filteredDatasetIds]
	);

	const currentIndex = useCallback(
		(currentId: number): number => {
			return filteredDatasetIds.indexOf(currentId);
		},
		[filteredDatasetIds]
	);

	const value = useMemo(
		() => ({
			filteredDatasetIds,
			setFilteredDatasetIds,
			getNextDatasetId,
			getPreviousDatasetId,
			currentIndex,
			totalCount: filteredDatasetIds.length,
			listPath,
			setListPath,
		}),
		[filteredDatasetIds, getNextDatasetId, getPreviousDatasetId, currentIndex, listPath]
	);

	return (
		<AuditNavigationContext.Provider value={value}>
			{children}
		</AuditNavigationContext.Provider>
	);
}

export function useAuditNavigation() {
	const context = useContext(AuditNavigationContext);
	if (!context) {
		// Return a safe default if used outside provider (e.g., direct navigation)
		return {
			filteredDatasetIds: [],
			setFilteredDatasetIds: () => {},
			getNextDatasetId: () => null,
			getPreviousDatasetId: () => null,
			currentIndex: () => -1,
			totalCount: 0,
			listPath: LIST_PATH,
			setListPath: () => {},
		};
	}
	return context;
}
