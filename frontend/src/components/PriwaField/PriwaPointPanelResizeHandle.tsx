import { ColumnWidthOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";

const MIN_PANEL_WIDTH = 560;
const VIEWPORT_MARGIN = 32;
const KEYBOARD_RESIZE_STEP = 32;

export const clampPriwaPointPanelWidth = (
  width: number,
  viewportWidth: number,
) => {
  const maxWidth = Math.max(MIN_PANEL_WIDTH, viewportWidth - VIEWPORT_MARGIN);
  return Math.min(maxWidth, Math.max(MIN_PANEL_WIDTH, width));
};

interface PriwaPointPanelResizeHandleProps {
  panelRef: RefObject<HTMLElement>;
}

export default function PriwaPointPanelResizeHandle({
  panelRef,
}: PriwaPointPanelResizeHandleProps) {
  const panelWidthRef = useRef<number | null>(null);
  const pendingPanelWidthRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const resizeStartRef = useRef<{ clientX: number; width: number } | null>(
    null,
  );

  const applyPanelWidth = useCallback(
    (width: number) => {
      pendingPanelWidthRef.current = clampPriwaPointPanelWidth(
        width,
        window.innerWidth,
      );
      if (animationFrameRef.current !== null) return;

      animationFrameRef.current = window.requestAnimationFrame(() => {
        const nextWidth = pendingPanelWidthRef.current;
        if (nextWidth !== null) {
          panelWidthRef.current = nextWidth;
          panelRef.current?.style.setProperty(
            "--priwa-point-panel-width",
            `${nextWidth}px`,
          );
        }
        animationFrameRef.current = null;
      });
    },
    [panelRef],
  );

  useLayoutEffect(() => {
    if (panelWidthRef.current !== null) {
      panelRef.current?.style.setProperty(
        "--priwa-point-panel-width",
        `${panelWidthRef.current}px`,
      );
    }
  });

  useEffect(
    () => () => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
      }
    },
    [],
  );

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const panelWidth = panelRef.current?.getBoundingClientRect().width;
    if (!panelWidth) return;

    resizeStartRef.current = { clientX: event.clientX, width: panelWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const continueResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeStart = resizeStartRef.current;
    if (!resizeStart) return;

    applyPanelWidth(resizeStart.width + (event.clientX - resizeStart.clientX));
  };

  const finishResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    resizeStartRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;

    const currentWidth = panelRef.current?.getBoundingClientRect().width;
    if (!currentWidth) return;

    applyPanelWidth(
      currentWidth +
        (event.key === "ArrowRight"
          ? KEYBOARD_RESIZE_STEP
          : -KEYBOARD_RESIZE_STEP),
    );
    event.preventDefault();
  };

  return (
    <div
      role="separator"
      aria-label="Tabellenbreite ändern"
      aria-orientation="vertical"
      tabIndex={0}
      title="Tabellenbreite ändern"
      data-testid="priwa-point-list-resize-handle"
      className="absolute right-0 top-1/2 z-10 hidden h-14 w-6 -translate-y-1/2 cursor-col-resize touch-none items-center justify-center rounded-l-md border border-r-0 border-slate-300 bg-white/95 text-slate-500 shadow-sm outline-none hover:border-emerald-500 hover:text-emerald-700 focus-visible:border-emerald-500 focus-visible:text-emerald-700 min-[992px]:flex"
      onPointerDown={startResize}
      onPointerMove={continueResize}
      onPointerUp={finishResize}
      onPointerCancel={finishResize}
      onLostPointerCapture={() => {
        resizeStartRef.current = null;
      }}
      onKeyDown={resizeWithKeyboard}
    >
      <ColumnWidthOutlined />
    </div>
  );
}
