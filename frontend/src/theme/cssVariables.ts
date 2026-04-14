import { cssColorTokens, hexToRgbTriplet } from "./palette";

/**
 * Applies theme CSS variables to :root at runtime.
 * This keeps `palette.ts` as the single source of truth.
 */
export const applyThemeCssVariables = (): void => {
  if (typeof document === "undefined") return;

  const root = document.documentElement;

  Object.entries(cssColorTokens).forEach(([name, hex]) => {
    root.style.setProperty(name, hex);
    root.style.setProperty(`${name}-rgb`, hexToRgbTriplet(hex));
  });
};

