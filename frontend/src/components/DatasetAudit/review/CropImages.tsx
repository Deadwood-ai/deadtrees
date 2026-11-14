import { useEffect, useRef, useState } from "react";
import type { IAuditImage } from "../../../types/auditChecks";
import CropImage from "./CropImage";

interface CropImagesProps {
	raw: IAuditImage | null;
	prediction: IAuditImage | null;
	/** what the prediction shows, e.g. "Deadwood prediction" */
	predictionLabel: string;
	/** both images next to each other (V), or one at a time */
	sideBySide: boolean;
	/** in single view: the prediction (T switches) */
	showPrediction: boolean;
	/** a new crop starts unzoomed */
	resetKey: number | null;
}

interface IZoom {
	scale: number;
	/** the point zoomed into, in percent of the image */
	x: number;
	y: number;
}

const NO_ZOOM: IZoom = { scale: 1, x: 50, y: 50 };
const MAX_SCALE = 6;

/** A crop as the models saw it: the raw image and the prediction over it, one at a time or side
 * by side. The wheel zooms both at once into the point under the cursor, so the same spot can be
 * compared. */
export default function CropImages({ raw, prediction, predictionLabel, sideBySide, showPrediction, resetKey }: CropImagesProps) {
	const [zoom, setZoom] = useState<IZoom>(NO_ZOOM);
	const box = useRef<HTMLDivElement>(null);
	useEffect(() => setZoom(NO_ZOOM), [resetKey]);

	// a native listener: React's wheel handler is passive and cannot keep the page from scrolling
	useEffect(() => {
		const el = box.current;
		if (!el) return;
		const onWheel = (event: WheelEvent) => {
			const pane = (event.target as HTMLElement).closest<HTMLElement>("[data-crop-pane]");
			if (!pane) return;
			event.preventDefault();
			const rect = pane.getBoundingClientRect();
			const x = ((event.clientX - rect.left) / rect.width) * 100;
			const y = ((event.clientY - rect.top) / rect.height) * 100;
			setZoom((z) => {
				const scale = Math.min(MAX_SCALE, Math.max(1, z.scale * (event.deltaY < 0 ? 1.25 : 0.8)));
				return scale === 1 ? NO_ZOOM : { scale, x, y };
			});
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, []);

	const panes = sideBySide
		? [
				{ label: "Raw", image: raw },
				{ label: predictionLabel, image: prediction },
			]
		: [showPrediction ? { label: predictionLabel, image: prediction } : { label: "Raw", image: raw }];

	return (
		<div ref={box} className="flex min-h-0 flex-1 items-center justify-center gap-2" data-testid="crop-images">
			{panes.map(({ label, image }) => (
				<div
					key={label}
					data-crop-pane
					className="relative flex aspect-square max-h-full min-w-0 flex-1 items-center justify-center overflow-hidden rounded-lg bg-slate-900"
					style={{ maxWidth: sideBySide ? "50%" : "100%" }}
				>
					{image ? (
						<CropImage
							image={image}
							className="h-full w-full select-none object-contain"
							style={{ transform: `scale(${zoom.scale})`, transformOrigin: `${zoom.x}% ${zoom.y}%` }}
						/>
					) : (
						<span className="text-xs text-slate-300">No stored image</span>
					)}
					<span className="absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-medium text-white">{label}</span>
					{zoom.scale > 1 && (
						<span className="absolute bottom-2 right-2 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white">{zoom.scale.toFixed(1)}×</span>
					)}
				</div>
			))}
		</div>
	);
}
