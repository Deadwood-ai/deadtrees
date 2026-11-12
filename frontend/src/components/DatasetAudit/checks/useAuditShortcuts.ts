import { useEffect, useRef } from "react";

/** Keys and what they do: a plain key ("k", "Enter", " "), "shift+Enter", or "mod+s" for Ctrl or
 * Cmd with S. An absent key is left alone. */
export type AuditKeyMap = Partial<Record<string, () => void>>;

/** A key pressed while typing in a field belongs to the field. */
const typing = (target: EventTarget | null) =>
	target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** Enter and Space on a focused button press that button. */
const onButton = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest("button");

/** The audit's keyboard: go through the steps with the keys, the mouse only to dig deeper. Each
 * part of the page passes the keys it answers while it is active: the steps Enter, Shift+Enter
 * and Ctrl+S, step 1 K and X, the crops n, p, Space and 1 to 3. Keys are ignored while you type
 * in a field (except Ctrl+S), and Enter or Space on a focused button press that button. */
export function useAuditShortcuts(keys: AuditKeyMap, active: boolean) {
	const current = useRef(keys);
	current.current = keys;
	useEffect(() => {
		if (!active) return;
		const onKey = (event: KeyboardEvent) => {
			const mod = event.ctrlKey || event.metaKey;
			const name = mod ? `mod+${event.key.toLowerCase()}` : event.shiftKey && event.key === "Enter" ? "shift+Enter" : event.key;
			if (!mod && (event.altKey || typing(event.target))) return;
			if ((event.key === "Enter" || event.key === " ") && onButton(event.target)) return;
			const action = current.current[name];
			if (!action) return;
			event.preventDefault();
			action();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [active]);
}
