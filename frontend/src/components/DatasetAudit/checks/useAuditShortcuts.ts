import { useEffect, useRef } from "react";

/** Keys and what they do: a plain key ("k", "Enter", " ", "ArrowRight"), "shift+Enter",
 * "shift+ " or "shift+Tab", or "mod+s" for Ctrl or Cmd with S. Letters match in either case. An
 * absent key is left alone. */
export type AuditKeyMap = Partial<Record<string, () => void>>;

/** A key pressed while typing in a field belongs to the field. A radio or checkbox (Ant Design's
 * button groups and switches are built on them) takes no typing, so the keys stay on. */
const typing = (target: EventTarget | null) =>
	target instanceof HTMLElement &&
	(target.isContentEditable ||
		["TEXTAREA", "SELECT"].includes(target.tagName) ||
		(target instanceof HTMLInputElement && !["radio", "checkbox"].includes(target.type)));

/** A key pressed in a dialog (a confirm step) belongs to the dialog, so the page behind it
 * cannot move on to another target while it asks. */
const inDialog = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest('[role="dialog"]');

/** Enter and Space on a focused button press that button; with Ctrl or Cmd they are shortcuts. */
const onButton = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest("button");

/** The keys that mean something else with Shift held. */
const SHIFTED = new Set(["Enter", " ", "Tab"]);

/** A key's name in an AuditKeyMap. */
function keyName(event: KeyboardEvent): string {
	const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
	if (event.ctrlKey || event.metaKey) return `mod+${key}`;
	return event.shiftKey && SHIFTED.has(event.key) ? `shift+${event.key}` : key;
}

/** The audit's keyboard: go through the steps with the keys, the mouse only to dig deeper. Each
 * part of the page passes the keys it answers while it is active: the steps Enter, Shift+Enter
 * and Ctrl+S, step 1 K and X, the crop review its own keys. Keys are ignored while you type
 * in a field (except Ctrl+S) or in a dialog, and Enter or Space on a focused button press that
 * button (Ctrl+Enter stays a shortcut). */
export function useAuditShortcuts(keys: AuditKeyMap, active: boolean) {
	const current = useRef(keys);
	current.current = keys;
	useEffect(() => {
		if (!active) return;
		const onKey = (event: KeyboardEvent) => {
			const name = keyName(event);
			if (inDialog(event.target)) return;
			if (!name.startsWith("mod+") && (event.altKey || typing(event.target))) return;
			if ((name === "Enter" || name === " ") && onButton(event.target)) return;
			const action = current.current[name];
			if (!action) return;
			event.preventDefault();
			action();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [active]);
}
