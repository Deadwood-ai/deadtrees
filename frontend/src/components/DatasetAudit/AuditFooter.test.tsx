// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import AuditFooter from "./AuditFooter";

afterEach(cleanup);

const footer = (props: Partial<Parameters<typeof AuditFooter>[0]> = {}) => {
	const onSaveAndNext = vi.fn();
	render(<AuditFooter nextDatasetId={7} isSaving={false} isAOIBusy={false} onCancel={vi.fn()} onSave={vi.fn()} onSaveAndNext={onSaveAndNext} {...props} />);
	return onSaveAndNext;
};

describe("AuditFooter", () => {
	it("Ctrl+Enter or Cmd+Enter is Save & Next", () => {
		const onSaveAndNext = footer();
		fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
		fireEvent.keyDown(window, { key: "Enter", metaKey: true });
		expect(onSaveAndNext).toHaveBeenCalledTimes(2);
	});

	it("does nothing without a next dataset, while saving or with AOI edits pending", () => {
		for (const props of [{ nextDatasetId: null }, { isSaving: true }, { isAOIBusy: true }]) {
			const onSaveAndNext = footer(props);
			fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
			expect(onSaveAndNext).not.toHaveBeenCalled();
			cleanup();
		}
	});
});
