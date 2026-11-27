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
