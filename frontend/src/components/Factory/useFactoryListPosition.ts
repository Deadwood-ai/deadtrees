import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

const positions = new Map<string, { top: number; left: number }>();

/** Restore after the rows render, including when they must be fetched again. */
export function useFactoryListPosition(ready: boolean) {
	const location = useLocation();
	const url = location.pathname + location.search;
	const container = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!ready) return;
		const position = positions.get(url);
		if (!position) return;
		// Run after the app's route-level scroll-to-top effect.
		const frame = requestAnimationFrame(() => {
			window.scrollTo({ top: position.top, behavior: "instant" });
			const table = container.current?.querySelector(".ant-table-content");
			if (table) table.scrollLeft = position.left;
		});
		return () => cancelAnimationFrame(frame);
	}, [ready, url]);

	const rememberPosition = () => {
		positions.delete(url);
		positions.set(url, {
			top: window.scrollY,
			left: container.current?.querySelector(".ant-table-content")?.scrollLeft ?? 0,
		});
		// Keep only recent list views during a long operator session.
		if (positions.size > 50) positions.delete(positions.keys().next().value!);
	};

	return { container, rememberPosition, returnTo: url };
}
