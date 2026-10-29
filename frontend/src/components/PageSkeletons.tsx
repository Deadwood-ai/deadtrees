import type { ReactNode } from "react";
import { Skeleton } from "antd";

import { SlowLoadingNote } from "./SectionStates";

// Whole-page loading states. They take the shape of the page that is on its
// way, fill the screen so the footer stays below the fold, and only explain
// themselves once a wait gets long. Failures use StatusPage instead.

// Faint 96 px grid, so the empty map area reads as a map and not as a gap.
const MAP_GRID_STYLE = {
  backgroundImage:
    "linear-gradient(to right, rgb(148 163 184 / 0.18) 1px, transparent 1px), linear-gradient(to bottom, rgb(148 163 184 / 0.18) 1px, transparent 1px)",
  backgroundSize: "96px 96px",
};

/** A map area that has not drawn yet: pulsing surface, grid and the outline of the zoom buttons. */
export function MapSkeleton({
  label,
  className = "",
  children,
}: {
  label: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={`relative h-full w-full overflow-hidden bg-slate-100 ${className}`}
      role="status"
      aria-label={label}
      data-testid="map-skeleton"
    >
      <div
        aria-hidden
        className="absolute inset-0 animate-pulse bg-gradient-to-br from-slate-100 via-slate-200/70 to-slate-100 motion-reduce:animate-none"
      />
      <div aria-hidden className="absolute inset-0" style={MAP_GRID_STYLE} />
      <div aria-hidden className="absolute bottom-6 right-4 flex flex-col gap-2">
        <div className="h-9 w-9 rounded-lg border border-white/80 bg-white/50" />
        <div className="h-9 w-9 rounded-lg border border-white/80 bg-white/50" />
      </div>
      {children}
      <div className="absolute inset-x-0 bottom-6 flex justify-center px-4">
        <SlowLoadingNote className="rounded-full bg-white/90 px-4 py-1.5 shadow-sm" />
      </div>
    </div>
  );
}

/** A map page on its way: the full-screen map plus the outline of its sidebar on desktop. */
export function MapPageSkeleton({ label }: { label: string }) {
  return (
    <div className="relative h-[100dvh] w-full">
      <MapSkeleton label={label}>
        <div
          aria-hidden
          className="absolute bottom-6 left-4 top-24 hidden w-96 flex-col gap-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm md:flex"
        >
          <Skeleton.Image active className="!h-40 !w-full" />
          <Skeleton active paragraph={{ rows: 3 }} />
          <Skeleton active title={false} paragraph={{ rows: 4, width: ["60%", "45%", "70%", "35%"] }} />
          <Skeleton.Button active block size="large" />
        </div>
      </MapSkeleton>
    </div>
  );
}

/** A content page on its way: heading and paragraph bars below the floating navigation. */
export function PageSkeleton({ label }: { label: string }) {
  return (
    <div
      className="flex min-h-[100dvh] w-full justify-center bg-[var(--dt-surface-base)] px-4 pb-12 pt-28 md:pt-32"
      role="status"
      aria-label={label}
      data-testid="page-skeleton"
    >
      <div className="flex w-full max-w-5xl flex-col gap-8">
        <Skeleton active title={{ width: "40%" }} paragraph={{ rows: 2, width: ["75%", "55%"] }} />
        <div className="rounded-2xl border border-slate-200 bg-white px-6 py-5">
          <Skeleton active title={false} paragraph={{ rows: 5, width: "100%" }} />
        </div>
        <SlowLoadingNote />
      </div>
    </div>
  );
}
