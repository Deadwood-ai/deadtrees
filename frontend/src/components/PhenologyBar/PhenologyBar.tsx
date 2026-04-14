import React, { useMemo, useState } from "react";
import { Tooltip } from "antd";
import { PhenologyMetadata } from "../../types/phenology";
import { generatePhenologyGradient, getAcquisitionPeriod, formatPhenologyTooltip } from "../../utils/phenologyUtils";
import { palette } from "../../theme/palette";

interface PhenologyBarProps {
  phenologyData?: PhenologyMetadata;
  acquisitionYear: string | number;
  acquisitionMonth?: string | number;
  acquisitionDay?: string | number;
  className?: string;
  showTooltips?: boolean;
}

export default function PhenologyBar({
  phenologyData,
  acquisitionYear,
  acquisitionMonth,
  acquisitionDay,
  className = "",
  showTooltips = true,
}: PhenologyBarProps) {
  const [hoveredDay, setHoveredDay] = useState<number | null>(null);

  // Generate gradient from phenology data
  const gradient = useMemo(() => {
    if (!phenologyData?.phenology_curve) {
      return `linear-gradient(to right, ${palette.neutral[100]}, ${palette.neutral[100]})`;
    }
    return generatePhenologyGradient(phenologyData.phenology_curve);
  }, [phenologyData]);

  // Calculate acquisition period
  const acquisitionPeriod = useMemo(() => {
    return getAcquisitionPeriod(acquisitionYear, acquisitionMonth, acquisitionDay);
  }, [acquisitionYear, acquisitionMonth, acquisitionDay]);

  // Handle mouse events for tooltips
  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!showTooltips || !phenologyData?.phenology_curve) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const relativeX = event.clientX - rect.left;
    const percentage = relativeX / rect.width;
    const dayOfYear = Math.round(percentage * 366) + 1;

    setHoveredDay(Math.min(dayOfYear, 366));
  };

  const handleMouseLeave = () => {
    setHoveredDay(null);
  };

  // Get tooltip content
  const tooltipContent = useMemo(() => {
    if (!hoveredDay || !phenologyData?.phenology_curve) return "";

    const phenologyValue = phenologyData.phenology_curve[hoveredDay - 1] || 0;
    const baseTooltip = formatPhenologyTooltip(hoveredDay, phenologyValue);

    return <div style={{ whiteSpace: "pre-line", maxWidth: "280px" }}>{baseTooltip}</div>;
  }, [hoveredDay, phenologyData]);

  // Calculate acquisition marker position and style
  const acquisitionMarkerStyle = useMemo(() => {
    const { type, startDay, endDay, centerDay } = acquisitionPeriod;

    if (type === "full") {
      // Single day - show arrow marker
      const position = ((centerDay - 1) / 366) * 100;
      return {
        type: "arrow",
        left: `${Math.max(0, Math.min(100, position))}%`,
      };
    } else if (type === "month") {
      // Month range - show highlighted section
      const startPos = ((startDay - 1) / 366) * 100;
      const endPos = ((endDay - 1) / 366) * 100;
      return {
        type: "range",
        left: `${Math.max(0, startPos)}%`,
        width: `${Math.min(100 - Math.max(0, startPos), endPos - startPos)}%`,
      };
    } else {
      // Year only - show entire bar highlighted
      return {
        type: "year",
        left: "0%",
        width: "100%",
      };
    }
  }, [acquisitionPeriod]);

  // Month labels and positions - position at start of each month
  const monthLabels = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
  const monthPositions = monthLabels.map((_, index) => (index / 12) * 100);

  if (!phenologyData?.phenology_curve) {
    return <div className={`text-xs text-gray-500 ${className}`}>Phenology data not available</div>;
  }

  return (
    <div className={`relative ${className}`}>
      <Tooltip
        title={tooltipContent}
        open={showTooltips && hoveredDay !== null}
        placement="top"
        styles={{ root: { pointerEvents: "none" } }}
      >
        <div className="relative px-2">
          {/* Main phenology bar */}
          <div
            className="relative h-2.5 w-full cursor-pointer overflow-visible rounded-sm border border-gray-300 shadow-sm"
            style={{
              background: gradient,
            }}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            role="img"
            aria-label={`Phenology timeline for ${acquisitionYear}${acquisitionMonth ? ` ${acquisitionMonth}` : ""}${acquisitionDay ? ` ${acquisitionDay}` : ""}`}
          >
            {/* Current day highlight */}
            {hoveredDay && (
              <div
                className="absolute top-0 z-30 h-full w-1 bg-black opacity-50"
                style={{
                  left: `${((hoveredDay - 1) / 366) * 100}%`,
                  transform: "translateX(-50%)",
                }}
              />
            )}
            {/* Acquisition marker overlay */}
            {acquisitionMarkerStyle.type === "arrow" && (
              <>
                {/* Vertical line - extends above and below bar */}
                <div
                  className="absolute -top-2 z-10 h-6 w-0.5 bg-blue-600 opacity-80"
                  style={{ left: acquisitionMarkerStyle.left, transform: "translateX(-50%)" }}
                />
                {/* Arrow pointing down */}
                <div
                  className="absolute -top-2 z-20 h-0 w-0 border-l-2 border-r-2 border-t-2 border-transparent border-t-blue-600"
                  style={{ left: acquisitionMarkerStyle.left, transform: "translateX(-50%)" }}
                />
              </>
            )}

            {acquisitionMarkerStyle.type === "range" && (
              <>
                {/* Month range highlight */}
                <div
                  className="absolute top-0 z-10 h-full bg-blue-500 opacity-40"
                  style={{
                    left: acquisitionMarkerStyle.left,
                    width: acquisitionMarkerStyle.width,
                  }}
                />
                {/* Start marker */}
                <div
                  className="absolute -top-2 z-20 h-6 w-0.5 bg-blue-600 opacity-80"
                  style={{ left: acquisitionMarkerStyle.left, transform: "translateX(-50%)" }}
                />
                {/* End marker */}
                <div
                  className="absolute -top-2 z-20 h-6 w-0.5 bg-blue-600 opacity-80"
                  style={{
                    left: `calc(${acquisitionMarkerStyle.left} + ${acquisitionMarkerStyle.width})`,
                    transform: "translateX(-50%)",
                  }}
                />
              </>
            )}

            {acquisitionMarkerStyle.type === "year" && (
              <div
                className="absolute top-0 z-10 h-full bg-blue-500 opacity-25"
                style={{
                  left: acquisitionMarkerStyle.left,
                  width: acquisitionMarkerStyle.width,
                }}
              />
            )}
          </div>

          {/* Month labels */}
          <div className="relative mt-0.5">
            {monthLabels.map((label, index) => (
              <div
                key={index}
                className="absolute"
                style={{ left: `${monthPositions[index]}%`, transform: "translateX(-50%)" }}
              >
                {/* Month label */}
                <span className="text-xs text-gray-500" style={{ fontSize: "9px" }}>
                  {label}
                </span>
              </div>
            ))}
          </div>
        </div>
      </Tooltip>
    </div>
  );
}
