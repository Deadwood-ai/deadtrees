/** True on macOS (and iPadOS), where shortcuts use ⌘ and ⌥ instead of Ctrl and Alt. */
export const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Modifier key names as the user's keyboard prints them. */
export const keyLabels = {
  mod: isMac ? "⌘" : "Ctrl",
  alt: isMac ? "⌥" : "Alt",
  shift: isMac ? "⇧" : "Shift",
} as const;
