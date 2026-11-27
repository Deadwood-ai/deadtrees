// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { Form } from "antd";

vi.mock("../benchmark/BenchmarkToggle", () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("./CogFacts", () => ({ default: () => null }));

import EvaluationStep from "./EvaluationStep";
import type { CogFactsProps } from "./CogFacts";
import type { IReviewDraft } from "../../../utils/auditReview";

beforeAll(() => {
	// Ant Design's form layout reads the breakpoints
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		value: (query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() }),
	});
});
afterEach(cleanup);

function step(active: boolean) {
	const { result } = renderHook(() => Form.useForm<IReviewDraft>());
	const [form] = result.current;
	render(
		<Form form={form}>
			<EvaluationStep datasetId={5} checks={undefined} cog={{} as CogFactsProps} thumbnailUrl={null} active={active} />
		</Form>,
	);
	const press = (key: string) => act(() => void fireEvent.keyDown(window, { key }));
	return { form, press };
}

describe("EvaluationStep keys", () => {
	it("decide with 1 and 2, and a reason key excludes for that reason", () => {
		const { form, press } = step(true);
		press("2");
		expect(form.getFieldValue("decision")).toBe("exclude");
		press("1");
		expect(form.getFieldValue("decision")).toBe("keep");
		press("w"); // the second reason
		expect([form.getFieldValue("decision"), form.getFieldValue("excludeReason")]).toEqual(["exclude", "no_trees"]);
	});

	it("leave the form alone while the step is closed", () => {
		const { form, press } = step(false);
		press("2");
		expect(form.getFieldValue("decision")).toBeUndefined();
	});
});
