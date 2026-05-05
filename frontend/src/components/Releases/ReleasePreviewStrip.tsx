import type { ReleasePreviewTile } from "../../data/releases";
import { SegmentationMaskPreview } from "./SegmentationMaskPreview";

interface ReleasePreviewStripProps {
  tiles: ReleasePreviewTile[];
  tileClassName?: string;
}

export function ReleasePreviewStrip({
  tiles,
  tileClassName = "",
}: ReleasePreviewStripProps) {
  return (
    <div className="grid grid-cols-2 gap-px bg-gray-200 sm:grid-cols-6">
      {tiles.map((tile) =>
        tile.kind === "image" ? (
          <div
            key={tile.key}
            className={`aspect-square overflow-hidden bg-gray-100 ${tileClassName}`}
          >
            <img
              src={tile.src}
              alt={tile.alt}
              loading="lazy"
              className="h-full w-full object-cover"
            />
          </div>
        ) : (
          <SegmentationMaskPreview
            key={tile.key}
            forestCoverSrc={tile.forestCoverSrc}
            deadwoodSrc={tile.deadwoodSrc}
            alt={tile.alt}
            size={256}
            className={tileClassName}
          />
        ),
      )}
    </div>
  );
}
