import { useEffect, useRef, useState, type ReactNode } from "react";

/** Keep a visible position indicator on touch browsers that hide native scrollbars. */
export default function MapPanelScrollArea({
  children,
  label,
  className = "",
}: {
  children: ReactNode;
  label: string;
  className?: string;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState({ height: 100, top: 0 });
  const update = () => {
    const element = viewport.current;
    if (!element) return;
    const height = Math.min(
      100,
      Math.max(5, (element.clientHeight / element.scrollHeight) * 100),
    );
    const top =
      element.scrollHeight > element.clientHeight
        ? (element.scrollTop / (element.scrollHeight - element.clientHeight)) *
          (100 - height)
        : 0;
    setThumb({ height, top });
  };
  useEffect(() => {
    const observer = new ResizeObserver(update);
    if (viewport.current) observer.observe(viewport.current);
    if (content.current) observer.observe(content.current);
    update();
    return () => observer.disconnect();
  }, []);
  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <div
        ref={viewport}
        data-map-panel-scroll-viewport
        onScroll={update}
        tabIndex={0}
        aria-label={label}
        className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${className}`}
      >
        <div ref={content}>{children}</div>
      </div>
      {thumb.height < 100 && (
        <div
          aria-hidden="true"
          data-testid="map-panel-scroll-indicator"
          className="pointer-events-none absolute bottom-2 right-1 top-2 w-1.5 rounded-full bg-slate-200"
        >
          <div
            className="absolute w-full rounded-full bg-slate-500"
            style={{ height: `${thumb.height}%`, top: `${thumb.top}%` }}
          />
        </div>
      )}
    </div>
  );
}
