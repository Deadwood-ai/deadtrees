import { useMemo, useState } from "react";
import type { IAcquisitionDateEstimate } from "../../types/acquisitionDate";
import { binToDate, dateToYearFraction, DOY_BINS } from "../../utils/acquisitionDate";
import { palette } from "../../theme/palette";

interface AcquisitionDateDistributionProps {
  estimate: IAcquisitionDateEstimate;
  /** ISO date of the recorded acquisition date, when it has a day */
  recordedDate?: string | null;
  height?: number;
}

const W = 360;
const PAD = { top: 16, right: 6, bottom: 16, left: 6 };
const MONTHS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
const COLORS = {
  line: palette.secondary[500],
  area: palette.secondary[300],
  hdi: palette.secondary[50],
  recorded: palette.neutral[900],
  estimate: palette.secondary[600],
  axis: palette.neutral[500],
  text: palette.neutral[700],
  surface: palette.neutral[0],
};

/**
 * The model's acquisition-date distribution over the flight year: an area of
 * the calibrated probabilities, the 80 % highest-density set shaded behind it,
 * the estimate (dashed) and the recorded date as labelled rules. Hover shows
 * the date and the probability of that week.
 */
export default function AcquisitionDateDistribution({ estimate, recordedDate, height = 96 }: AcquisitionDateDistributionProps) {
  const [hoverBin, setHoverBin] = useState<number | null>(null);
  const plotW = W - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const p = estimate.probabilities;
  const maxP = useMemo(() => Math.max(...p), [p]);
  const x = (fraction: number) => PAD.left + fraction * plotW;
  const y = (v: number) => PAD.top + plotH - (v / maxP) * plotH;

  const pts = p.map((v, i) => `${x((i + 0.5) / DOY_BINS).toFixed(1)},${y(v).toFixed(1)}`);
  const base = (PAD.top + plotH).toFixed(1);
  const linePath = `M${pts.join("L")}`;
  const areaPath = `M${x(0.5 / DOY_BINS).toFixed(1)},${base}L${pts.join("L")}L${x((DOY_BINS - 0.5) / DOY_BINS).toFixed(1)},${base}Z`;

  const hdi80 = estimate.hdi["80"] ?? [];
  const markers = [
    { key: "estimate", iso: estimate.predicted_date, color: COLORS.estimate, dash: "4 3", label: "Estimate" },
    ...(recordedDate ? [{ key: "recorded", iso: recordedDate, color: COLORS.recorded, dash: undefined, label: "Recorded" }] : []),
  ];

  // labels sit above the plot, anchored away from the nearer edge; when the
  // markers are close the second label drops to a row inside the plot
  const placed = markers
    .map((m) => ({ ...m, x: x(dateToYearFraction(m.iso) + 0.5 / DOY_BINS) }))
    .sort((a, b) => a.x - b.x)
    .map((m, i, all) => {
      const close = all.length > 1 && Math.abs(all[1].x - all[0].x) < 60;
      const anchor = m.x > W - 40 ? "end" : m.x < 40 ? "start" : "middle";
      return {
        ...m,
        anchor,
        dx: anchor === "end" ? -3 : anchor === "start" ? 3 : 0,
        y: close && i === 1 ? PAD.top + 9 : PAD.top - 5,
      };
    });

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = (e.clientX - rect.left) / rect.width;
    setHoverBin(Math.max(0, Math.min(DOY_BINS - 1, Math.floor(fraction * DOY_BINS))));
  };

  const hover =
    hoverBin === null
      ? null
      : {
          date: binToDate(hoverBin, estimate.flight_year).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }),
          // probability of the surrounding week
          week: p.slice(Math.max(0, hoverBin - 3), hoverBin + 4).reduce((a, b) => a + b, 0),
        };

  return (
    <div className="relative w-full">
      <svg
        viewBox={`0 0 ${W} ${height}`}
        className="block w-full"
        role="img"
        aria-label={`Estimated acquisition date distribution for ${estimate.flight_year}; estimate ${estimate.predicted_date}`}
      >
        {hdi80.map(([start, end]) => {
          const x0 = x(dateToYearFraction(start));
          const x1 = x(dateToYearFraction(end) + 1 / DOY_BINS);
          return <rect key={start} x={x0} y={PAD.top} width={Math.max(1, x1 - x0)} height={plotH} fill={COLORS.hdi} />;
        })}
        <path d={areaPath} fill={COLORS.area} fillOpacity={0.35} />
        <path d={linePath} fill="none" stroke={COLORS.line} strokeWidth={2} strokeLinejoin="round" />
        <line x1={PAD.left} x2={W - PAD.right} y1={PAD.top + plotH} y2={PAD.top + plotH} stroke={COLORS.axis} strokeWidth={1} />
        {placed.map((m) => (
          <g key={m.key}>
            <line x1={m.x} x2={m.x} y1={PAD.top - 2} y2={PAD.top + plotH} stroke={m.color} strokeWidth={2} strokeDasharray={m.dash} />
            <text x={m.x} y={m.y} textAnchor={m.anchor} dx={m.dx} fontSize={9} fill={COLORS.text} stroke={COLORS.surface} strokeWidth={3} paintOrder="stroke">
              {m.label}
            </text>
          </g>
        ))}
        {MONTHS.map((label, i) => (
          <text key={i} x={x((i + 0.5) / 12)} y={height - 4} textAnchor="middle" fontSize={9} fill={COLORS.text}>
            {label}
          </text>
        ))}
        {hoverBin !== null && (
          <line
            x1={x((hoverBin + 0.5) / DOY_BINS)}
            x2={x((hoverBin + 0.5) / DOY_BINS)}
            y1={PAD.top}
            y2={PAD.top + plotH}
            stroke={COLORS.axis}
            strokeWidth={1}
          />
        )}
        <rect
          x={PAD.left}
          y={0}
          width={plotW}
          height={height}
          fill="transparent"
          onMouseMove={onMove}
          onMouseLeave={() => setHoverBin(null)}
        />
      </svg>
      {hover && (
        <div
          className="pointer-events-none absolute top-0 rounded border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] text-gray-700 shadow-sm"
          style={{ left: `${((hoverBin! + 0.5) / DOY_BINS) * 100}%`, transform: "translateX(-50%)" }}
        >
          {hover.date}: {(hover.week * 100).toFixed(1)}% in that week
        </div>
      )}
    </div>
  );
}
