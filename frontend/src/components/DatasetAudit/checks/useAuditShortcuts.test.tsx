// @vitest-environment jsdom
import { fireEvent, render, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAuditShortcuts } from "./useAuditShortcuts";

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
});
