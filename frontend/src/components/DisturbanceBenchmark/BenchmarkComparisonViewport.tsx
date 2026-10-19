import { useRef } from "react";
import { useBenchmarkAsset } from "./BenchmarkAccess";
import ReferencePolygonOverlay from "./ReferencePolygonOverlay";
import type { IReferencePolygons } from "./types";

interface BenchmarkComparisonViewportProps {
  aspect: string;
  image: string;
  alt: string;
  polygons?: IReferencePolygons;
  view: { zoom: number; x: number; y: number };
  onPan: (dx: number, dy: number) => void;
}

export default function BenchmarkComparisonViewport({
  aspect,
  image,
  alt,
  polygons,
  view,
  onPan,
}: BenchmarkComparisonViewportProps) {
  const benchmarkAsset = useBenchmarkAsset();
  const drag = useRef<{ x: number; y: number } | null>(null);
  const endDrag = () => {
    drag.current = null;
  };
  return (
    <div
      className="db-context-comparison-viewport"
      style={{
        aspectRatio: aspect,
        cursor: view.zoom > 1 ? "grab" : "default",
      }}
      onPointerDown={(event) => {
        if (view.zoom === 1 || event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        onPan(
          (event.clientX - drag.current.x) / bounds.width,
          (event.clientY - drag.current.y) / bounds.height,
        );
        drag.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
    >
      <div
        className="db-context-comparison-image"
        style={{
          transform: `translate(${view.x * 100}%, ${view.y * 100}%) scale(${view.zoom})`,
        }}
      >
        <img src={benchmarkAsset(image)} alt={alt} draggable={false} />
        <ReferencePolygonOverlay polygons={polygons} />
      </div>
    </div>
  );
}
