import { describe, expect, it } from "vitest";
import type { AuditSectionId } from "../../../utils/auditChecks";
import { nextStep, previousStep } from "./auditCheckView";

const order: AuditSectionId[] = ["evaluation", "aoi", "georef", "date", "phenology", "deadwood", "forest"];

describe("nextStep", () => {
	it("goes to the next step in order and ends after the last", () => {
		expect(nextStep(order, "evaluation")).toBe("aoi");
		expect(nextStep(order, "deadwood")).toBe("forest");
		expect(nextStep(order, "forest")).toBeNull();
	});
});

describe("previousStep", () => {
	it("goes one step back and stops at the first", () => {
		expect(previousStep(order, "georef")).toBe("aoi");
		expect(previousStep(order, "evaluation")).toBeNull();
	});
});
