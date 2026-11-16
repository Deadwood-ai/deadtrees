// @vitest-environment jsdom
import type { CSSProperties } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { IAuditImage } from "../../../types/auditChecks";

vi.mock("./CropImage", () => ({
	default: ({ image, style, decorative }: { image: IAuditImage; style?: CSSProperties; decorative?: boolean }) => (
		<img data-testid={`image-${image.kind}`} data-decorative={decorative ? "yes" : "no"} alt={decorative ? "" : image.kind} style={style} />
	),
}));

import CropImages from "./CropImages";

afterEach(cleanup);

const image = (id: number, kind: IAuditImage["kind"]) => ({ id, kind, storage_path: `audit/crops/1/${kind}.jpg` }) as IAuditImage;
const raw = image(1, "raw");
const prediction = image(2, "deadwood_overlay");

describe("the crop images", () => {
	it("lay the prediction over the raw image at the chosen opacity", () => {
		render(
			<CropImages raw={raw} prediction={prediction} predictionLabel="Deadwood prediction" sideBySide={false} showPrediction opacity={0.4} resetKey={1} />,
		);
		// the raw layer underneath is decorative, so the pane still reads as one image
		expect(screen.getByTestId("image-raw").dataset.decorative).toBe("yes");
		expect(screen.getByTestId("image-deadwood_overlay").style.opacity).toBe("0.4");
	});

	it("show the raw pane without a prediction over it", () => {
		render(
			<CropImages raw={raw} prediction={prediction} predictionLabel="Deadwood prediction" sideBySide={false} showPrediction={false} opacity={0.4} resetKey={1} />,
		);
		expect(screen.getByTestId("image-raw").style.opacity).toBe("");
		expect(screen.queryByTestId("image-deadwood_overlay")).toBeNull();
	});

	it("put raw under the prediction side by side too", () => {
		render(<CropImages raw={raw} prediction={prediction} predictionLabel="Deadwood prediction" sideBySide showPrediction opacity={1} resetKey={1} />);
		expect(screen.getAllByTestId("image-raw")).toHaveLength(2);
		expect(screen.getByTestId("image-deadwood_overlay").style.opacity).toBe("1");
	});
});
