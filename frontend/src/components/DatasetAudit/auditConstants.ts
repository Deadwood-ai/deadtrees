// Constants for the Dataset Audit Detail component

export const AUDIT_INFO = {
	georeferencing:
		"Georeferencing accuracy: Good (<15m) means properly aligned with map features. Poor (>15m) should be excluded from analysis.",
	acquisitionDate:
		"Validate if acquisition date matches visual indicators like leaf color, snow cover, or seasonal characteristics. Invalid dates should be excluded.",
	phenology:
		"Assess seasonal appropriateness: In Season means appropriate for the region and time. Out of Season (especially in non-tropical regions) should be excluded from Sentinel training.",
	deadwoodQuality:
		"Rate deadwood segmentation prediction quality: Great = highly accurate, OK = acceptable for Sentinel training, Bad = poor quality predictions.",
	forestCoverQuality:
		"Evaluate forest cover segmentation quality: Great = precise boundaries and classification, OK = acceptable accuracy, Bad = poor segmentation results.",
	cogIssues:
		"Assess Cloud-Optimized GeoTIFF quality: Check transparency, black/white areas, color band consistency, and artifacts. Good = no issues, Issues = problems detected.",
	thumbnailIssues:
		"Evaluate thumbnail quality: Check color accuracy, appropriate zoom level, white background (correct no-data values), and absence of artifacts. Good = meets standards, Issues = problems found.",
	aoi: "Define the area of interest for analysis. Draw a polygon on the map to specify the region that should be analyzed. Only required for datasets with no issues.",
	finalAssessment:
		"Final assessment of dataset quality and usability. No Issues = ready for production use and analysis. Fixable Issues = has problems that can be corrected through processing or manual fixes. Exclude Completely = fundamental issues that make the dataset unusable, should be removed from the platform entirely. Review the technical metadata below to make an informed decision.",
};

// Helper to format acquisition date from dataset
export const formatAcquisitionDate = (dataset: {
	aquisition_day?: number | string | null;
	aquisition_month?: number | string | null;
	aquisition_year?: number | string | null;
}): string => {
	const day = dataset.aquisition_day;
	const month = dataset.aquisition_month;
	const year = dataset.aquisition_year;

	if (!year) return "Date not available";

	if (month) {
		const monthNum = typeof month === "string" ? parseInt(month) : month;
		const yearNum = typeof year === "string" ? parseInt(year) : year;
		const dayNum = day ? (typeof day === "string" ? parseInt(day) : day) : 1;

		const date = new Date(yearNum, monthNum - 1, dayNum);

		if (day) {
			return date.toLocaleDateString("en-GB", {
				day: "numeric",
				month: "long",
				year: "numeric",
			});
		} else {
			return date.toLocaleDateString("en-GB", {
				month: "long",
				year: "numeric",
			});
		}
	}

	return year.toString();
};

// Conditional validation rule factory
export const createConditionalRule = (errorMessage: string) => [
	({ getFieldValue }: { getFieldValue: (name: string) => unknown }) => ({
		validator(_: unknown, value: unknown) {
			const assessment = getFieldValue("final_assessment");
			// If assessment is not "no_issues", field is optional
			if (assessment !== "no_issues") {
				return Promise.resolve();
			}
			// For no_issues, field is required
			if (value === null || value === undefined || value === "") {
				return Promise.reject(new Error(errorMessage));
			}
			return Promise.resolve();
		},
	}),
];
