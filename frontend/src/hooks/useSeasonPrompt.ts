import { message } from "antd";

export interface DatasetSeasonInfo {
	admin_level_2?: string;
	admin_level_3?: string;
	country?: string;
	biome_name?: string;
	acquisition_date?: string;
	latitude?: number;
}

function getHemisphere(latitude: number | undefined): string {
	if (latitude === undefined) return "Unknown";
	return latitude >= 0 ? "Northern Hemisphere" : "Southern Hemisphere";
}

export function generateSeasonPrompt(dataset: DatasetSeasonInfo): string {
	const hemisphere = getHemisphere(dataset.latitude);

	return `Classify the attached aerial/drone thumbnail as IN SEASON or OUT OF SEASON.

DATASET:
Location: ${dataset.admin_level_3 || "Unknown"}, ${dataset.admin_level_2 || "Unknown"}, ${dataset.country || "Unknown"}
Biome: ${dataset.biome_name || "Unknown"}
Acquisition: ${dataset.acquisition_date || "Unknown"}
Latitude: ${dataset.latitude?.toFixed(2) || "Unknown"} (${hemisphere})

RULES:

1. TROPICAL/SUBTROPICAL: Always IN SEASON (no leaf-off period).
   Examples: Brazil, Indonesia, Philippines, Congo, coastal Australia.

2. TEMPERATE/BOREAL: Use hemisphere + acquisition month.
   Northern (Europe, USA, Canada): IN SEASON May 15 - Oct 15
   Southern (Australia, Chile, NZ): IN SEASON Oct 15 - May 15

3. Follow calendar strictly even if vegetation appears green.
   Spring/Autumn transitional periods count as OUT OF SEASON.

4. Visual confirmation (don't override calendar rules):
   - Leafless deciduous trees, snow, brown grass = OUT OF SEASON
   - Full green canopy in summer months = IN SEASON

5. Edge cases:
   - Mediterranean: use temperate rules (summer drought may brown grass)
   - High altitude: shorter season (Jun-Sep)
   - Mixed forest: classify based on deciduous trees

6. If uncertain, determine: location > climate zone > hemisphere > month.

RESPOND: IN SEASON, OUT OF SEASON, or UNCERTAIN with brief explanation.`;
}

async function fetchImageAsPngBlob(url: string): Promise<Blob> {
	// Fetch the image
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);
	
	const originalBlob = await response.blob();
	
	// If already PNG, return as-is
	if (originalBlob.type === "image/png") {
		return originalBlob;
	}
	
	// Convert to PNG using canvas
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.crossOrigin = "anonymous";
		
		img.onload = () => {
			const canvas = document.createElement("canvas");
			canvas.width = img.naturalWidth;
			canvas.height = img.naturalHeight;
			
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				reject(new Error("Failed to get canvas context"));
				return;
			}
			
			ctx.drawImage(img, 0, 0);
			canvas.toBlob((blob) => {
				if (blob) {
					resolve(blob);
				} else {
					reject(new Error("Failed to convert image to PNG"));
				}
			}, "image/png");
		};
		
		img.onerror = () => reject(new Error("Failed to load image"));
		img.src = URL.createObjectURL(originalBlob);
	});
}

async function copySeasonPromptWithImage(
	dataset: DatasetSeasonInfo,
	thumbnailUrl: string
): Promise<void> {
	const prompt = generateSeasonPrompt(dataset);

	// Check if ClipboardItem is supported
	if (typeof ClipboardItem === "undefined") {
		console.debug("ClipboardItem not supported");
		await navigator.clipboard.writeText(prompt);
		message.info("Prompt copied (image copy not supported in this browser)");
		return;
	}

	try {
		// Fetch and convert thumbnail to PNG
		const pngBlob = await fetchImageAsPngBlob(thumbnailUrl);

		// Create clipboard items with both text and image
		const clipboardItems = [
			new ClipboardItem({
				"text/plain": new Blob([prompt], { type: "text/plain" }),
				"image/png": pngBlob,
			}),
		];

		await navigator.clipboard.write(clipboardItems);
		message.success("Prompt and image copied to clipboard!");
	} catch (err) {
		// Fallback: copy text only
		console.debug("Image clipboard failed, falling back to text only:", err);
		await navigator.clipboard.writeText(prompt);
		message.info("Prompt copied (image copy not supported)");
	}
}

async function copySeasonPromptTextOnly(dataset: DatasetSeasonInfo): Promise<void> {
	const prompt = generateSeasonPrompt(dataset);
	await navigator.clipboard.writeText(prompt);
	message.success("Season prompt copied to clipboard!");
}

// Hook for use in components
export function useSeasonPrompt() {
	const copyPromptWithImage = async (
		dataset: DatasetSeasonInfo,
		thumbnailUrl: string
	) => {
		await copySeasonPromptWithImage(dataset, thumbnailUrl);
	};

	const copyPromptTextOnly = async (dataset: DatasetSeasonInfo) => {
		await copySeasonPromptTextOnly(dataset);
	};

	return { copyPromptWithImage, copyPromptTextOnly, generateSeasonPrompt };
}
