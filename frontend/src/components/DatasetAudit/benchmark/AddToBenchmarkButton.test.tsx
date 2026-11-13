// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const privileges = vi.hoisted(() => ({ canOperate: false }));
const mutateAsync = vi.hoisted(() => vi.fn());
const members = vi.hoisted(() => ({ data: [] as { crop_id: number | null; benchmark: { check_key: string } }[] }));

vi.mock("../../../hooks/useUserPrivileges", () => ({ useCanOperate: () => privileges }));
vi.mock("../../../hooks/useAuditBenchmarks", () => ({
	useBenchmarkMembership: () => members,
	useAddBenchmarkTarget: () => ({ mutateAsync, isPending: false }),
}));

import AddToBenchmarkButton from "./AddToBenchmarkButton";

beforeEach(() => {
	privileges.canOperate = false;
	members.data = [];
	mutateAsync.mockReset().mockResolvedValue({ id: 1, split: "dev" });
});
afterEach(cleanup);

describe("AddToBenchmarkButton", () => {
	it("is hidden from auditors who do not operate, and B does nothing for them", () => {
		render(<AddToBenchmarkButton checkKey="dataset_evaluation" datasetId={5} active />);
		expect(screen.queryByTestId("add-to-benchmark")).toBeNull();
		fireEvent.keyDown(window, { key: "b" });
		expect(mutateAsync).not.toHaveBeenCalled();
	});

	it("adds the whole dataset for an operator, by click or with B while step 1 is open", async () => {
		privileges.canOperate = true;
		const { rerender } = render(<AddToBenchmarkButton checkKey="dataset_evaluation" datasetId={5} active={false} />);
		fireEvent.keyDown(window, { key: "b" });
		expect(mutateAsync).not.toHaveBeenCalled();
		rerender(<AddToBenchmarkButton checkKey="dataset_evaluation" datasetId={5} active />);
		fireEvent.keyDown(window, { key: "B" });
		await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ checkKey: "dataset_evaluation", datasetId: 5, cropId: null }));
		// a second press while the first one runs is ignored
		await waitFor(() => expect(screen.getByTestId("add-to-benchmark").className).not.toContain("ant-btn-loading"));
		fireEvent.click(screen.getByTestId("add-to-benchmark"));
		await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
	});

	it("says when the dataset is already in the open benchmark", () => {
		privileges.canOperate = true;
		members.data = [{ crop_id: null, benchmark: { check_key: "dataset_evaluation" } }];
		render(<AddToBenchmarkButton checkKey="dataset_evaluation" datasetId={5} active />);
		expect(screen.getByTestId("add-to-benchmark").textContent).toContain("In benchmark");
		fireEvent.keyDown(window, { key: "b" });
		expect(mutateAsync).not.toHaveBeenCalled();
	});
});
