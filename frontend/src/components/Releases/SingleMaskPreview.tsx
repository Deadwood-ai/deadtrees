import { useEffect, useState } from "react";

import { composeSingleMaskDataUrl } from "./maskRendering";
import { useNearViewport } from "./useNearViewport";

interface SingleMaskPreviewProps {
  src: string;
  layer: "tree-cover" | "deadwood";
  alt: string;
  mode?: "opaque" | "transparent";
  opacity?: number;
  size?: number;
  className?: string;
}

export function SingleMaskPreview({
  src,
  layer,
  alt,
  mode = "opaque",
  opacity = 1,
  size = 256,
  className = "",
}: SingleMaskPreviewProps) {
  const { ref: wrapperRef, isNear: shouldRender } =
    useNearViewport<HTMLDivElement>();
  const [maskDataUrl, setMaskDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!shouldRender) return;

    let cancelled = false;
    setMaskDataUrl(null);

    composeSingleMaskDataUrl({ src, layer, mode, opacity, size })
      .then((dataUrl) => {
        if (!cancelled) setMaskDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setMaskDataUrl(null);
      });

    return () => {
      cancelled = true;
    };
  }, [layer, mode, opacity, shouldRender, size, src]);

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
