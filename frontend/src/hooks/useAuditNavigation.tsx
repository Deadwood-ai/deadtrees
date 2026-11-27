import { createContext, useContext, useState, ReactNode, useMemo } from "react";

interface AuditNavigationContextValue {
	/** the audit list with the tab and filters the auditor came from */
	listPath: string;
	setListPath: (path: string) => void;
}

const LIST_PATH = "/dataset-audit";

const AuditNavigationContext = createContext<AuditNavigationContextValue | null>(null);

/** Where a review goes back to: the audit list with the tab and filters it was opened from. */
export function AuditNavigationProvider({ children }: { children: ReactNode }) {
	const [listPath, setListPath] = useState(LIST_PATH);
	const value = useMemo(() => ({ listPath, setListPath }), [listPath]);
	return <AuditNavigationContext.Provider value={value}>{children}</AuditNavigationContext.Provider>;
}

export function useAuditNavigation() {
	const context = useContext(AuditNavigationContext);
	// a safe default outside the provider (e.g. direct navigation)
	return context ?? { listPath: LIST_PATH, setListPath: () => {} };
}
