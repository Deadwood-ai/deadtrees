import { useState, type WheelEvent } from "react";
import { useAuditImageAccess } from "../../../hooks/useAuditChecks";
import { auditImageUrl } from "../../../api/auditImages";
import type { AuditImageKind, IAuditImage } from "../../../types/auditChecks";

export interface IPaneImage {
	kind: AuditImageKind;
	caption: string;
}

interface CropImagePaneProps {
	images: IAuditImage[];
	/** the panels shown side by side, in order */
	panels: IPaneImage[];
	/** side by side, or one image */
	sideBySide: boolean;
	/** in one-image mode: the panel shown */
	single: AuditImageKind;
	/** a panel's outline marks the layer being answered */
	active?: AuditImageKind | null;
}

/** The stored images of one crop, side by side or one at a time; the wheel zooms every panel
 * at once and a double click resets. Images come by crop from audit.images, so crops made off
 * the CLIP grid (the DT-1272 gold crops) work too. A thin stand-in until the audit's
 * CropReviewer (review/CropReviewer.tsx) is shared. */
export default function CropImagePane({ images, panels, sideBySide, single, active }: CropImagePaneProps) {
	const { data: grant, isError } = useAuditImageAccess();
	const [zoom, setZoom] = useState({ scale: 1, x: 50, y: 50 });
	const shown = sideBySide ? panels : panels.filter((p) => p.kind === single);
	const onWheel = (event: WheelEvent<HTMLDivElement>) => {
		const box = event.currentTarget.getBoundingClientRect();
		const scale = Math.min(8, Math.max(1, zoom.scale * (event.deltaY < 0 ? 1.25 : 0.8)));
		setZoom({ scale, x: ((event.clientX - box.left) / box.width) * 100, y: ((event.clientY - box.top) / box.height) * 100 });
	};
	if (isError) return <div className="p-4 text-sm text-red-600">The crop images could not be opened.</div>;
	return (
		<div className={`grid gap-2 ${shown.length > 1 ? "grid-cols-3" : "grid-cols-1"}`} data-testid="benchmark-crop-images">
			{shown.map((panel) => {
				const image = images.find((i) => i.kind === panel.kind);
				return (
					<figure
						key={panel.kind}
						className={`relative m-0 aspect-square overflow-hidden rounded bg-black ${active === panel.kind ? "ring-2 ring-sky-400" : ""}`}
						onWheel={onWheel}
						onDoubleClick={() => setZoom({ scale: 1, x: 50, y: 50 })}
					>
						{image && grant ? (
							<img
								src={auditImageUrl(grant, image.storage_path)}
								alt={panel.caption}
								className="h-full w-full object-contain"
								style={{ transform: `scale(${zoom.scale})`, transformOrigin: `${zoom.x}% ${zoom.y}%` }}
								draggable={false}
							/>
						) : (
							<div className="flex h-full items-center justify-center text-xs text-gray-400">{image ? "Loading…" : "No stored image"}</div>
						)}
						<figcaption className="absolute left-1.5 top-1.5 rounded bg-black/60 px-1.5 text-[11px] text-white">{panel.caption}</figcaption>
					</figure>
				);
			})}
		</div>
	);
}
