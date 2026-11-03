import { useEffect, useState } from "react";

export interface HeldModifiers {
  shift: boolean;
  alt: boolean;
}

/** Which of Shift and Alt (⌥) are held right now, while `enabled`; both false otherwise. */
export function useHeldModifiers(enabled: boolean): HeldModifiers {
  const [held, setHeld] = useState<HeldModifiers>({ shift: false, alt: false });
  useEffect(() => {
    if (!enabled) return;
    const update = (e: KeyboardEvent | MouseEvent) =>
      setHeld({ shift: e.shiftKey, alt: e.altKey });
    const reset = () => setHeld({ shift: false, alt: false });
    window.addEventListener("keydown", update);
    window.addEventListener("keyup", update);
    window.addEventListener("pointermove", update);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", update);
      window.removeEventListener("keyup", update);
      window.removeEventListener("pointermove", update);
      window.removeEventListener("blur", reset);
      reset();
    };
  }, [enabled]);
  return held;
}
