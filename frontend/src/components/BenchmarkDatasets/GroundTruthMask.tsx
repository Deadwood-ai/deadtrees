import { useEffect, useRef, useState } from "react";

export const GROUND_TRUTH_COLORS = {
  background: "#BDBDBD",
  forestCover: "#087C69",
  deadwood: "#FF9800",
} as const;

const parseHexColor = (hex: string): [number, number, number] => {
  const normalized = hex.replace("#", "");
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
};

const imageLoadCache = new Map<string, Promise<HTMLImageElement>>();
const composedMaskCache = new Map<string, Promise<string>>();

const loadImage = (src: string) => {
  const cached = imageLoadCache.get(src);
  if (cached) return cached;

  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });

  imageLoadCache.set(src, promise);
  return promise;
};

export const composeMaskDataUrl = ({
  forestCoverSrc,
  deadwoodSrc,
  mode,
  opacity,
  size,
}: {
  forestCoverSrc: string;
  deadwoodSrc: string;
  mode: "opaque" | "transparent";
  opacity: number;
  size: number;
}) => {
  const cacheKey = `${forestCoverSrc}|${deadwoodSrc}|${mode}|${opacity}|${size}`;
  const cached = composedMaskCache.get(cacheKey);
  if (cached) return cached;

  const promise = Promise.all([
    loadImage(forestCoverSrc),
    loadImage(deadwoodSrc),
  ]).then(([forestImage, deadwoodImage]) => {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Could not create mask canvas context");

    const background = parseHexColor(GROUND_TRUTH_COLORS.background);
    const forestCover = parseHexColor(GROUND_TRUTH_COLORS.forestCover);
    const deadwood = parseHexColor(GROUND_TRUTH_COLORS.deadwood);

    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = size;
    maskCanvas.height = size;
    const maskCtx = maskCanvas.getContext("2d", { willReadFrequently: true });
    if (!maskCtx)
      throw new Error("Could not create source mask canvas context");

    maskCtx.drawImage(forestImage, 0, 0, size, size);
    const forestData = maskCtx.getImageData(0, 0, size, size).data;

    maskCtx.clearRect(0, 0, size, size);
    maskCtx.drawImage(deadwoodImage, 0, 0, size, size);
    const deadwoodData = maskCtx.getImageData(0, 0, size, size).data;

    const output = ctx.createImageData(size, size);

    for (let i = 0; i < output.data.length; i += 4) {
      const forestPositive = forestData[i] > 127;
      const deadwoodPositive = deadwoodData[i] > 127;
      const color = deadwoodPositive
        ? deadwood
        : forestPositive
          ? forestCover
          : background;
      const alpha =
        mode === "transparent"
          ? deadwoodPositive || forestPositive
            ? Math.round(opacity * 255)
            : 0
          : 255;

      output.data[i] = color[0];
      output.data[i + 1] = color[1];
      output.data[i + 2] = color[2];
      output.data[i + 3] = alpha;
    }

    ctx.putImageData(output, 0, 0);
    return canvas.toDataURL("image/png");
  });

  const cachedPromise = promise.catch((error) => {
    composedMaskCache.delete(cacheKey);
    throw error;
  });

  composedMaskCache.set(cacheKey, cachedPromise);
  return cachedPromise;
};

interface GroundTruthMaskProps {
  forestCoverSrc: string;
  deadwoodSrc: string;
  alt: string;
  mode?: "opaque" | "transparent";
  opacity?: number;
  size?: number;
  className?: string;
}

export function GroundTruthMask({
  forestCoverSrc,
  deadwoodSrc,
  alt,
  mode = "opaque",
  opacity = 1,
  size = 256,
  className = "",
}: GroundTruthMaskProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [shouldRender, setShouldRender] = useState(false);
  const [maskDataUrl, setMaskDataUrl] = useState<string | null>(null);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    if (!("IntersectionObserver" in window)) {
      setShouldRender(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShouldRender(true);
          observer.disconnect();
        }
      },
      { rootMargin: "180px" },
    );

    observer.observe(wrapper);

    return () => observer.disconnect();
  }, []);

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
