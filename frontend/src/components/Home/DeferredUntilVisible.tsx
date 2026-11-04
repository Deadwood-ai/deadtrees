import { useEffect, useRef, useState, type ReactNode } from "react";

export const DeferredUntilVisible = ({
  children,
  className,
  placeholder,
  rootMargin,
  testId,
}: {
  children: ReactNode;
  className?: string;
  placeholder: ReactNode;
  rootMargin: string;
  testId?: string;
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (isVisible || !containerRef.current) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [isVisible, rootMargin]);

  return (
    <div ref={containerRef} className={className} data-testid={testId}>
      {isVisible ? children : placeholder}
    </div>
  );
};

/**
 * An autoplaying video starts downloading in full as soon as it is on the page,
 * even with preload="metadata". This one joins the page when it comes near the
 * viewport, and its size is reserved so nothing shifts when it does.
 */
export const DeferredVideo = ({
  src,
  width,
  height,
  className,
}: {
  src: string;
  width: number;
  height: number;
  className?: string;
}) => (
  <div style={{ aspectRatio: `${width} / ${height}` }}>
    <DeferredUntilVisible
      className="h-full w-full"
      placeholder={<div className="h-full w-full bg-gray-100" />}
      rootMargin="300px 0px"
    >
      <video
        src={src}
        autoPlay
        loop
        muted
        playsInline
        preload="metadata"
        className={className}
      />
    </DeferredUntilVisible>
  </div>
);
