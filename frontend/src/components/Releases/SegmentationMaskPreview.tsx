import { useEffect, useState } from "react";

import { composeMaskDataUrl } from "./maskRendering";
import { useNearViewport } from "./useNearViewport";

interface SegmentationMaskPreviewProps {
  forestCoverSrc: string;
  deadwoodSrc: string;
  alt: string;
  mode?: "opaque" | "transparent";
  opacity?: number;
  size?: number;
  className?: string;
}

export function SegmentationMaskPreview({
  forestCoverSrc,
  deadwoodSrc,
  alt,
  mode = "opaque",
  opacity = 1,
  size = 256,
  className = "",
}: SegmentationMaskPreviewProps) {
  const { ref: wrapperRef, isNear: shouldRender } =
    useNearViewport<HTMLDivElement>();
  const [maskDataUrl, setMaskDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!shouldRender) return;

    let cancelled = false;
    setMaskDataUrl(null);

    composeMaskDataUrl({ forestCoverSrc, deadwoodSrc, mode, opacity, size })
      .then((dataUrl) => {
        if (!cancelled) setMaskDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setMaskDataUrl(null);
      });

    return () => {
      cancelled = true;
    };
  }, [deadwoodSrc, forestCoverSrc, mode, opacity, shouldRender, size]);

  return (
    <div
      ref={wrapperRef}
      className={`aspect-square overflow-hidden ${
        mode === "opaque" ? "bg-[#BDBDBD]" : "bg-transparent"
      } ${className}`}
    >
      {maskDataUrl && (
        <img
          src={maskDataUrl}
          alt={alt}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      )}
    </div>
  );
}
