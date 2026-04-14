import { hexToRgba, palette } from "./palette";

export const mapColors = {
  forest: {
    fill: palette.forest[600],
    text: palette.forest[600],
    gradient: "from-green-100 via-green-400 to-green-700",
  },
  deadwood: {
    fill: palette.deadwood[500],
    text: palette.deadwood[600],
    gradient: "from-amber-100 via-amber-400 to-amber-700",
  },
  aoi: {
    stroke: palette.secondary[500],
    fill: hexToRgba(palette.secondary[500], 0.2),
  },
  flag: {
    stroke: palette.primary[500],
    fill: palette.primary[500],
  },
} as const;

