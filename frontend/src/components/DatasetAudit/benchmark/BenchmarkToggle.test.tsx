// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const privileges = vi.hoisted(() => ({ canOperate: false }));
const save = vi.hoisted(() => vi.fn());
const remove = vi.hoisted(() => vi.fn());
const membership = vi.hoisted(() => ({
	data: { dataset: false, tiles: [] as { tile_id: number; layer: string }[] },
	isFetching: false,
	isLoading: false,
	refetch: vi.fn(),
}));

vi.mock("../../../hooks/useUserPrivileges", () => ({ useCanOperate: () => privileges }));
vi.mock("../../../hooks/useAuditChecks", () => ({ useSaveDatasetReviews: () => ({ mutateAsync: save }) }));
vi.mock("../../../hooks/useAuditBenchmarks", () => ({
	useBenchmarkMembership: () => membership,
	useRemoveBenchmarkTargets: () => ({ mutateAsync: remove }),
}));

import BenchmarkToggle from "./BenchmarkToggle";

const review = { dataset_id: 5, check_key: "dataset_evaluation" as const, decision: "keep" as const };
const label = vi.fn();

beforeEach(() => {
	privileges.canOperate = false;
	membership.data = { dataset: false, tiles: [] };
	membership.isFetching = false;
	save.mockReset().mockResolvedValue([{ id: 1 }]);
	remove.mockReset().mockResolvedValue([{ dataset_id: 5, tile_id: null }]);
	label.mockReset().mockReturnValue({ review });
});
afterEach(cleanup);

const toggle = () => screen.getByRole("switch") as HTMLButtonElement;

describe("BenchmarkToggle", () => {
	it("is hidden from auditors who do not operate, and B does nothing for them", () => {
		render(<BenchmarkToggle datasetId={5} label={label} active />);
		expect(screen.queryByTestId("benchmark-toggle")).toBeNull();
		fireEvent.keyDown(window, { key: "b" });
		expect(save).not.toHaveBeenCalled();
	});

	it("stores your decision ticked for the benchmark when the dataset is not in it, by click or with B", async () => {
		privileges.canOperate = true;
		render(<BenchmarkToggle datasetId={5} label={label} active />);
		expect(screen.getByTestId("benchmark-toggle").textContent).toContain("Benchmark (B)");
		expect(toggle().getAttribute("aria-checked")).toBe("false");
		fireEvent.keyDown(window, { key: "B" });
		await waitFor(() => expect(save).toHaveBeenCalledWith([{ ...review, in_benchmark: true }]));
		expect(remove).not.toHaveBeenCalled();
	});

	it("stores nothing without a decision", async () => {
		privileges.canOperate = true;
		label.mockReturnValue({ problem: "Pick OK or Exclude first" });
		render(<BenchmarkToggle datasetId={5} label={label} active />);
		fireEvent.click(toggle());
		await waitFor(() => expect(label).toHaveBeenCalledOnce());
		expect(save).not.toHaveBeenCalled();
	});

	it("takes the dataset out when it is in the benchmark", async () => {
		privileges.canOperate = true;
		membership.data = { dataset: true, tiles: [] };
		render(<BenchmarkToggle datasetId={5} label={label} active />);
		expect(toggle().getAttribute("aria-checked")).toBe("true");
		fireEvent.click(toggle());
		await waitFor(() => expect(remove).toHaveBeenCalledWith([{ dataset_id: 5, tile_id: null }]));
		expect(save).not.toHaveBeenCalled();
	});

	it("is off while the membership is read again", () => {
		privileges.canOperate = true;
		membership.isFetching = true;
		render(<BenchmarkToggle datasetId={5} label={label} active />);
		expect(toggle().disabled).toBe(true);
		fireEvent.keyDown(window, { key: "b" });
		expect(save).not.toHaveBeenCalled();
	});
});
