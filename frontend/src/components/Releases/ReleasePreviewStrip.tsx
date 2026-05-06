import type { ReleasePreviewTile } from "../../data/releases";
import { SegmentationMaskPreview } from "./SegmentationMaskPreview";
import { SingleMaskPreview } from "./SingleMaskPreview";

interface ReleasePreviewStripProps {
  tiles: ReleasePreviewTile[];
  tileClassName?: string;
  className?: string;
}

export function ReleasePreviewStrip({
  tiles,
  tileClassName = "",
  className = "grid grid-cols-2 gap-px bg-gray-200 sm:grid-cols-6",
}: ReleasePreviewStripProps) {
  return (
    <div className={className}>
      {tiles.map((tile) => {
        if (tile.kind === "image") {
          return (
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
          );
        }

        if (tile.kind === "single-mask") {
          return (
            <SingleMaskPreview
              key={tile.key}
              src={tile.src}
              layer={tile.layer}
              alt={tile.alt}
              size={256}
              className={tileClassName}
            />
          );
        }

        return (
          <SegmentationMaskPreview
            key={tile.key}
            forestCoverSrc={tile.forestCoverSrc}
            deadwoodSrc={tile.deadwoodSrc}
            alt={tile.alt}
            size={256}
            className={tileClassName}
          />
        );
      })}
    </div>
  );
}
