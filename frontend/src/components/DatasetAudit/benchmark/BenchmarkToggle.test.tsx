// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const privileges = vi.hoisted(() => ({ canOperate: false }));
const add = vi.hoisted(() => vi.fn());
const remove = vi.hoisted(() => vi.fn());
const membership = vi.hoisted(() => ({
	data: [] as { crop_id: number | null; benchmark: { check_key: string; layer: string | null } }[],
	isFetching: false,
	isLoading: false,
	refetch: vi.fn(),
}));

vi.mock("../../../hooks/useUserPrivileges", () => ({ useCanOperate: () => privileges }));
vi.mock("../../../hooks/useAuditBenchmarks", () => ({
	useBenchmarkMembership: () => membership,
	useAddBenchmarkTarget: () => ({ mutateAsync: add }),
	useRemoveBenchmarkTarget: () => ({ mutateAsync: remove }),
}));

import BenchmarkToggle from "./BenchmarkToggle";

beforeEach(() => {
	privileges.canOperate = false;
	membership.data = [];
	membership.isFetching = false;
	add.mockReset().mockResolvedValue({ id: 1, split: "dev" });
	remove.mockReset().mockResolvedValue([{ dataset_id: 5, crop_id: null }]);
	beforeAdd.mockReset().mockResolvedValue(true);
});
afterEach(cleanup);

const beforeAdd = vi.fn();
const toggle = () => screen.getByRole("switch") as HTMLButtonElement;

describe("BenchmarkToggle", () => {
	it("is hidden from auditors who do not operate, and B does nothing for them", () => {
		render(<BenchmarkToggle datasetId={5} beforeAdd={beforeAdd} active />);
		expect(screen.queryByTestId("benchmark-toggle")).toBeNull();
		fireEvent.keyDown(window, { key: "b" });
		expect(add).not.toHaveBeenCalled();
	});

	it("adds the dataset labeled with your decision when it is not a member, by click or with B", async () => {
		privileges.canOperate = true;
		render(<BenchmarkToggle datasetId={5} beforeAdd={beforeAdd} active />);
		expect(screen.getByTestId("benchmark-toggle").textContent).toContain("Benchmark (B)");
		expect(toggle().getAttribute("aria-checked")).toBe("false");
		fireEvent.keyDown(window, { key: "B" });
		await waitFor(() => expect(add).toHaveBeenCalledWith({ benchmark: { check_key: "dataset_evaluation", layer: null }, datasetId: 5, cropId: null }));
		expect(beforeAdd).toHaveBeenCalledOnce();
		expect(remove).not.toHaveBeenCalled();
	});

	it("leaves the dataset out when its label could not be stored", async () => {
		privileges.canOperate = true;
		beforeAdd.mockResolvedValue(false);
		render(<BenchmarkToggle datasetId={5} beforeAdd={beforeAdd} active />);
		fireEvent.click(toggle());
		await waitFor(() => expect(beforeAdd).toHaveBeenCalledOnce());
		expect(add).not.toHaveBeenCalled();
	});

	it("removes the dataset when it is a member", async () => {
		privileges.canOperate = true;
		membership.data = [{ crop_id: null, benchmark: { check_key: "dataset_evaluation", layer: null } }];
		render(<BenchmarkToggle datasetId={5} beforeAdd={beforeAdd} active />);
		expect(toggle().getAttribute("aria-checked")).toBe("true");
		fireEvent.click(toggle());
		await waitFor(() => expect(remove).toHaveBeenCalledWith({ benchmark: { check_key: "dataset_evaluation", layer: null }, datasetId: 5, cropId: null }));
		expect(add).not.toHaveBeenCalled();
		expect(beforeAdd).not.toHaveBeenCalled();
	});

	it("is off while the membership is read again", () => {
		privileges.canOperate = true;
		membership.isFetching = true;
		render(<BenchmarkToggle datasetId={5} beforeAdd={beforeAdd} active />);
		expect(toggle().disabled).toBe(true);
		fireEvent.keyDown(window, { key: "b" });
		expect(add).not.toHaveBeenCalled();
	});
});
