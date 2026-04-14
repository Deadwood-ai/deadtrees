import { palette } from "../theme/palette";

/**
 * Calculate day of year from date components
 * Handles different date granularities (year only, year+month, full date)
 */
export function calculateDayOfYear(year: string | number, month?: string | number, day?: string | number): number {
  const yearNum = typeof year === "string" ? parseInt(year) : year;
  const monthNum = month ? (typeof month === "string" ? parseInt(month) : month) : 1;
  const dayNum = day ? (typeof day === "string" ? parseInt(day) : day) : 1;

  // Create date object and calculate day of year
  const date = new Date(yearNum, monthNum - 1, dayNum);
  const startOfYear = new Date(yearNum, 0, 1);
  const dayOfYear = Math.floor((date.getTime() - startOfYear.getTime()) / (1000 * 60 * 60 * 24)) + 1;

  return Math.min(dayOfYear, 366); // Cap at 366 for leap years
}

/**
 * Get acquisition period information for visualization
 */
export function getAcquisitionPeriod(
  year: string | number,
  month?: string | number,
  day?: string | number,
): {
  type: "full" | "month" | "year";
  startDay: number;
  endDay: number;
  centerDay: number;
} {
  if (day) {
    const dayOfYear = calculateDayOfYear(year, month, day);
    return {
      type: "full",
      startDay: dayOfYear,
      endDay: dayOfYear,
      centerDay: dayOfYear,
    };
  } else if (month) {
    const monthNum = typeof month === "string" ? parseInt(month) : month;
    const yearNum = typeof year === "string" ? parseInt(year) : year;

    // Get first and last day of the month
    const firstDay = calculateDayOfYear(year, month, 1);
    const lastDayOfMonth = new Date(yearNum, monthNum, 0).getDate();
    const lastDay = calculateDayOfYear(year, month, lastDayOfMonth);

    return {
      type: "month",
      startDay: firstDay,
      endDay: lastDay,
      centerDay: Math.floor((firstDay + lastDay) / 2),
    };
  } else {
    return {
      type: "year",
      startDay: 1,
      endDay: 366,
      centerDay: 183, // Approximate middle of year
    };
  }
}

/**
 * Map phenology value (0-255) to color
 */
export function mapPhenologyValueToColor(value: number): string {
  // Clamp value to 0-255 range
  const clampedValue = Math.max(0, Math.min(255, value));

  // Simple gradient from light grey to dark green
  const ratio = clampedValue / 255;
  return interpolateColor(palette.neutral[100], palette.forest[700], ratio);
}

/**
 * Generate CSS gradient from phenology curve
 */
export function generatePhenologyGradient(phenologyCurve: number[]): string {
  if (!phenologyCurve || phenologyCurve.length === 0) {
    return `linear-gradient(to right, ${palette.neutral[100]}, ${palette.neutral[100]})`;
  }

  // Sample points for gradient (every ~7 days to keep gradient manageable)
  const sampleInterval = Math.max(1, Math.floor(phenologyCurve.length / 52));
  const gradientStops: string[] = [];

  for (let i = 0; i < phenologyCurve.length; i += sampleInterval) {
    const value = phenologyCurve[i];
    const color = mapPhenologyValueToColor(value);
    const position = (i / (phenologyCurve.length - 1)) * 100;
    gradientStops.push(`${color} ${position.toFixed(1)}%`);
  }

  // Ensure we have the last point
  if (gradientStops.length > 0) {
    const lastValue = phenologyCurve[phenologyCurve.length - 1];
    const lastColor = mapPhenologyValueToColor(lastValue);
    gradientStops.push(`${lastColor} 100%`);
  }

  return `linear-gradient(to right, ${gradientStops.join(", ")})`;
}

/**
 * Format tooltip content for phenology visualization
 */
export function formatPhenologyTooltip(dayOfYear: number, phenologyValue: number): string {
  const date = dayOfYearToDate(dayOfYear);
  const probabilityPercent = Math.round((Math.max(0, Math.min(255, phenologyValue)) / 255) * 100);

  return `Day ${dayOfYear} (${date})
Probability to be in Maximum Greenness Period: ${probabilityPercent}%

Ecosystems without annual seasonal dynamics or large interspecies phenological variability may show incorrect dynamics.

Based on gap-filled VIIRS phenology data (VNP22Q2v001), averaged at 10 km and across years (2013-2022).

Source: NASA VIIRS Land Phenology ESDR & Mosig et al. 2026 deadtrees.earth, RSE.`;
}

/**
 * Convert day of year to readable date format
 */
function dayOfYearToDate(dayOfYear: number): string {
  // Use current year as reference, but this is just for display
  const year = new Date().getFullYear();
  const date = new Date(year, 0, dayOfYear);

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/**
 * Interpolate between two hex colors
 */
function interpolateColor(color1: string, color2: string, ratio: number): string {
  const hex1 = color1.replace("#", "");
  const hex2 = color2.replace("#", "");

  const r1 = parseInt(hex1.substring(0, 2), 16);
  const g1 = parseInt(hex1.substring(2, 4), 16);
  const b1 = parseInt(hex1.substring(4, 6), 16);

  const r2 = parseInt(hex2.substring(0, 2), 16);
  const g2 = parseInt(hex2.substring(2, 4), 16);
  const b2 = parseInt(hex2.substring(4, 6), 16);

  const r = Math.round(r1 + (r2 - r1) * ratio);
  const g = Math.round(g1 + (g2 - g1) * ratio);
  const b = Math.round(b1 + (b2 - b1) * ratio);

  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}
