// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuditShortcuts } from "./useAuditShortcuts";

afterEach(cleanup);

describe("useAuditShortcuts", () => {
	it("leaves keys pressed in a dialog to the dialog", () => {
		const next = vi.fn();
		renderHook(() => useAuditShortcuts({ ArrowRight: next, Tab: next }, true));
		const { getByRole } = render(
			<div role="dialog">
				<button type="button">Remove crop</button>
			</div>,
		);
		const button = getByRole("button");
		fireEvent.keyDown(button, { key: "ArrowRight" });
		fireEvent.keyDown(button, { key: "Tab" });
		expect(next).not.toHaveBeenCalled();
		// outside the dialog the same keys still work
		fireEvent.keyDown(document.body, { key: "ArrowRight" });
		expect(next).toHaveBeenCalledTimes(1);
	});

	it("leaves Enter on a focused button to the button, but not Ctrl+Enter", () => {
		const enter = vi.fn();
		const saveAndNext = vi.fn();
		renderHook(() => useAuditShortcuts({ Enter: enter, "mod+Enter": saveAndNext }, true));
		const { getByRole } = render(<button type="button">Dataset evaluation</button>);
		const button = getByRole("button");
		fireEvent.keyDown(button, { key: "Enter" });
		expect(enter).not.toHaveBeenCalled();
		// the shortcut wins, and the browser does not press the button as well
		expect(fireEvent.keyDown(button, { key: "Enter", ctrlKey: true })).toBe(false);
		expect(saveAndNext).toHaveBeenCalledTimes(1);
	});
});
