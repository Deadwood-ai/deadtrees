import { useEffect, useRef, useState } from "react";

export type PriwaMapInteractionMode =
  "browse" | "place-point" | "select-offline-area";

export function usePriwaMapInteractionMode() {
  const [mode, setMode] = useState<PriwaMapInteractionMode>("browse");
  const modeRef = useRef<PriwaMapInteractionMode>(mode);
  const isPlacingPoint = mode === "place-point";

  useEffect(() => {
    modeRef.current = mode;
    document.body.classList.toggle("priwa-placement-mode", isPlacingPoint);

    return () => document.body.classList.remove("priwa-placement-mode");
  }, [isPlacingPoint, mode]);

  return {
    isPlacingPoint,
    isSelectingOfflineArea: mode === "select-offline-area",
    mode,
    modeRef,
    setMode,
  };
}
