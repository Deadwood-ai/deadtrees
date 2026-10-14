import { useEffect, useRef, useState } from "react";

// Becomes true once the element comes within 180px of the visible area and
// stays true. IntersectionObserver respects clipping by scroll containers, so
// cards far along a horizontally scrolled gallery row are not loaded up front,
// which native loading="lazy" does not guarantee.
export function useNearViewport<T extends Element>() {
  const ref = useRef<T | null>(null);
  const [isNear, setIsNear] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    if (!("IntersectionObserver" in window)) {
      setIsNear(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "180px" },
    );

    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  return { ref, isNear };
}
