import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { Button } from "antd";
import { CloseOutlined } from "@ant-design/icons";

type SheetSnap = "compact" | "expanded";

interface MobileBottomSheetProps {
  children: ReactNode;
  open: boolean;
  title: string;
  onClose: () => void;
  compactRatio?: number;
  expandedRatio?: number;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const getViewportHeight = () =>
  typeof window === "undefined" ? 844 : window.innerHeight;
const CLOSE_THRESHOLD_PX = 160;
const CLOSE_ANIMATION_MS = 220;

const MobileBottomSheet = ({
  children,
  open,
  title,
  onClose,
  compactRatio = 0.52,
  expandedRatio = 0.86,
}: MobileBottomSheetProps) => {
  const [viewportHeight, setViewportHeight] = useState(getViewportHeight);
  const [snap, setSnap] = useState<SheetSnap>("expanded");
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const dragStartRef = useRef<{
    height: number;
    y: number;
  } | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const updateViewportHeight = () => setViewportHeight(getViewportHeight());
    updateViewportHeight();
    window.addEventListener("resize", updateViewportHeight);
    return () => window.removeEventListener("resize", updateViewportHeight);
  }, []);

  useEffect(() => {
    if (open) {
      setSnap("expanded");
      setDragHeight(null);
      setIsClosing(false);
    }
  }, [open]);

  const compactHeight = useMemo(
    () => Math.round(viewportHeight * compactRatio),
    [compactRatio, viewportHeight],
  );
  const closeHeight = Math.max(180, compactHeight - CLOSE_THRESHOLD_PX);
  const expandedHeight = useMemo(
    () => Math.round(viewportHeight * expandedRatio),
    [expandedRatio, viewportHeight],
  );
  const snappedHeight = snap === "expanded" ? expandedHeight : compactHeight;
  const currentHeight = dragHeight ?? snappedHeight;

  useEffect(
    () => () => {
      dragCleanupRef.current?.();
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
    },
    [],
  );

  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      event.preventDefault();
      dragCleanupRef.current?.();

      dragStartRef.current = {
        height: currentHeight,
        y: event.clientY,
      };
      setDragHeight(currentHeight);

      let lastHeight = currentHeight;
      const handlePointerMove = (pointerEvent: PointerEvent) => {
        const dragStart = dragStartRef.current;
        if (!dragStart) return;

        const nextHeight = clamp(
          dragStart.height + dragStart.y - pointerEvent.clientY,
          closeHeight,
          expandedHeight,
        );
        lastHeight = nextHeight;
        setDragHeight(nextHeight);
      };

      const handlePointerUp = () => {
        const midpoint = compactHeight + (expandedHeight - compactHeight) / 2;
        dragStartRef.current = null;
        dragCleanupRef.current?.();

        if (lastHeight <= closeHeight) {
          setDragHeight(lastHeight);
          setIsClosing(true);
          closeTimerRef.current = window.setTimeout(() => {
            closeTimerRef.current = null;
            setDragHeight(null);
            onClose();
          }, CLOSE_ANIMATION_MS);
          return;
        }

        setDragHeight(null);
        setSnap(lastHeight >= midpoint ? "expanded" : "compact");
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp, { once: true });
      window.addEventListener("pointercancel", handlePointerUp, { once: true });

      dragCleanupRef.current = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
        dragCleanupRef.current = null;
      };
    },
    [closeHeight, compactHeight, currentHeight, expandedHeight, onClose],
  );

  if (!open) return null;

  return (
    <section
      className="deadtrees-mobile-control-panel pointer-events-auto fixed inset-x-0 bottom-0 z-[1000] mx-auto flex w-full max-w-[640px] flex-col overflow-hidden rounded-t-[24px] border border-slate-200 bg-white shadow-2xl shadow-slate-950/20 md:hidden"
      style={{
        height: currentHeight,
        transform: isClosing ? "translateY(110%)" : "translateY(0)",
        transition:
          dragHeight === null || isClosing
            ? `height 180ms ease-out, transform ${CLOSE_ANIMATION_MS}ms ease-in`
            : "none",
      }}
      aria-label={title}
    >
      <header
        className="touch-none select-none border-b border-slate-100 bg-white px-4 pb-3 pt-2"
        onPointerDown={startDrag}
      >
        <div className="mx-auto mb-2 h-1.5 w-12 rounded-full bg-slate-300" />
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-slate-950">
              {title}
            </h2>
          </div>
          <Button
            shape="circle"
            icon={<CloseOutlined />}
            aria-label={`Close ${title}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
          />
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4">
        {children}
      </div>
    </section>
  );
};

export default MobileBottomSheet;
