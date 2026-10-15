import { useMemo } from "react";
import type { IReferencePolygons } from "./types";

interface ReferencePolygonOverlayProps {
  polygons?: IReferencePolygons;
}
export default function ReferencePolygonOverlay({
  polygons,
}: ReferencePolygonOverlayProps) {
  const path = useMemo(
    () =>
      polygons?.features
        .flatMap((feature) => {
          const shapes =
            feature.geometry.type === "Polygon"
              ? [feature.geometry.coordinates as number[][][]]
              : (feature.geometry.coordinates as number[][][][]);
          return shapes.map((polygon) =>
            polygon
              .map(
                (ring) =>
                  ring
                    .map(
                      (point, index) =>
                        `${index === 0 ? "M" : "L"}${point[0]},${point[1]}`,
                    )
                    .join(" ") + " Z",
              )
              .join(" "),
          );
        })
        .join(" "),
    [polygons],
  );
  if (!path) return null;
  return (
    <svg
      className="db-reference-svg"
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path
        d={path}
        fill="none"
        fillRule="evenodd"
        stroke="white"
        strokeWidth="0.75"
        opacity="0.9"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
