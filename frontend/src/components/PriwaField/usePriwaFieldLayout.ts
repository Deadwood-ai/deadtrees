import { useEffect, useState } from "react";

import {
  resolvePriwaFieldLayout,
  type IPriwaFieldLayout,
} from "./priwaFieldLayout";

const COARSE_POINTER_QUERY = "(pointer: coarse)";

const readLayout = (): IPriwaFieldLayout =>
  resolvePriwaFieldLayout({
    viewportWidth: typeof window === "undefined" ? 1280 : window.innerWidth,
    viewportHeight: typeof window === "undefined" ? 800 : window.innerHeight,
    isCoarsePointer:
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(COARSE_POINTER_QUERY).matches,
  });

export const usePriwaFieldLayout = (): IPriwaFieldLayout => {
  const [layout, setLayout] = useState(readLayout);

  useEffect(() => {
    const update = () => {
      const next = readLayout();
      setLayout((current) =>
        current.isFieldLayout === next.isFieldLayout &&
        current.isLandscape === next.isLandscape &&
        current.flightPanelPlacement === next.flightPanelPlacement
          ? current
          : next,
      );
    };
    update();
    const pointerQuery =
      typeof window.matchMedia === "function"
        ? window.matchMedia(COARSE_POINTER_QUERY)
        : null;
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    pointerQuery?.addEventListener?.("change", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      pointerQuery?.removeEventListener?.("change", update);
    };
  }, []);

  return layout;
};
