/**
 * DeadTrees design tokens.
 * This file is the single source of truth for application colors.
 */
export const palette = {
  // Contribution-first brand color (logo foliage inspired)
  primary: {
    50: "#EAFAF0",
    100: "#C8F0D8",
    500: "#1B5E35",
    600: "#164D2C",
    700: "#103D22",
  },
  // Exploration/info color family (from DT-115 palette discussion)
  secondary: {
    50: "#E1EFFF",
    300: "#88B5E0",
    500: "#2E7AC0",
    600: "#1F5FAF",
  },
  // Forest-specific map/UI semantics
  forest: {
    100: "#DDF8E8",
    300: "#7CE380",
    500: "#29D280",
    600: "#22C55E",
    700: "#1F8A45",
  },
  // Deadwood-specific map/UI semantics
  deadwood: {
    100: "#FFF4D9",
    500: "#FFB31C",
    600: "#CC8F16",
    700: "#AE5920",
  },
  state: {
    success: "#22C55E",
    error: "#EF4444",
    warning: "#FFB31C",
    info: "#2E7AC0",
    pending: "#9CA3AF",
    hover: "#1FA58A",
    selected: "#AE5920",
    measure: "#FFCC33",
  },
  neutral: {
    0: "#FFFFFF",
    50: "#F8FAFC",
    100: "#F1F5F9",
    200: "#E1EFFF",
    300: "#D7C49A",
    500: "#9CA3AF",
    700: "#6B7280",
    800: "#495669",
    900: "#1F2937",
  },
} as const;

export const semanticColors = {
  textPrimary: palette.neutral[900],
  surfaceBase: palette.neutral[50],
  surfaceRaised: palette.neutral[0],
  surfaceSoft: palette.secondary[50],
  borderSubtle: palette.neutral[100],
  infoPanel: palette.secondary[50],
} as const;

/**
 * Semantic role aliases for easier design discussions.
 */
export const colorRoles = {
  contribute: palette.primary[500],
  explore: palette.secondary[500],
  accent: palette.deadwood[500],
  forest: palette.forest[500],
  text: semanticColors.textPrimary,
} as const;

type HexColor = `#${string}`;

const normalizeHex = (hex: HexColor): string => {
  const stripped = hex.replace("#", "");
  if (stripped.length === 3) {
    return stripped
      .split("")
      .map((c) => c + c)
      .join("");
  }
  return stripped;
};

export const hexToRgbTriplet = (hex: HexColor): string => {
  const normalized = normalizeHex(hex);
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return `${r} ${g} ${b}`;
};

export const hexToRgba = (hex: HexColor, alpha: number): string => {
  const [r, g, b] = hexToRgbTriplet(hex).split(" ");
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

/**
 * CSS custom properties generated from this same source.
 * These are consumed by Tailwind and plain CSS.
 */
export const cssColorTokens = {
  "--dt-primary": palette.primary[500],
  "--dt-secondary": palette.secondary[500],
  "--dt-forest": palette.forest[500],
  "--dt-deadwood": palette.deadwood[500],
  "--dt-deadwood-dark": palette.deadwood[600],
  "--dt-surface-base": semanticColors.surfaceBase,
  "--dt-surface-raised": semanticColors.surfaceRaised,
  "--dt-surface-soft": semanticColors.surfaceSoft,
  "--dt-text-primary": semanticColors.textPrimary,
} as const;

