import { useEffect, useRef } from "react";

/** What the audit's keys do; an absent action leaves its key alone. */
export interface IAuditShortcuts {
	/** Enter: take the open step's suggestion and move on */
	accept?: () => void;
	/** Shift+Enter: the step before */
	back?: () => void;
	/** Ctrl+S or Cmd+S: save the audit */
	save?: () => void;
}

/** A key pressed while typing in a field (or on a focused button, for Enter) belongs to it. */
export const typing = (target: EventTarget | null) =>
	target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName));

/** The audit's step keys: go through the steps with the keyboard, the mouse only to dig deeper.
 * Step 1 adds K and X, the crops n, p, space and 1 to 3. Keys are ignored while you type in a
 * field; Enter on a focused button presses that button. */
export function useAuditShortcuts(shortcuts: IAuditShortcuts, enabled: boolean) {
	const current = useRef(shortcuts);
	current.current = shortcuts;
	useEffect(() => {
		if (!enabled) return;
		const onKey = (event: KeyboardEvent) => {
			const s = current.current;
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
				if (!s.save) return;
				event.preventDefault();
				s.save();
				return;
			}
			if (event.ctrlKey || event.metaKey || event.altKey || typing(event.target)) return;
			const action = event.key === "Enter" ? (event.shiftKey ? s.back : s.accept) : undefined;
			if (!action) return;
			event.preventDefault();
			action();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [enabled]);
}
