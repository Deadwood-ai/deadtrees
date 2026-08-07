import { PRIWA_WARNKARTE_RED_BANDS } from "./createPriwaWarnkarteLayer";
import { formatPriwaWarnkarteDate } from "./priwaWarnkartePresentation";

interface PriwaWarnkarteLegendProps {
  sourceDate: string | null;
}

const bandLabel = (index: number) =>
  index === 0
    ? "Wahrscheinlichkeit 0,0 bis 0,1"
    : `Wahrscheinlichkeit ${((index + 1) / 10).toFixed(1).replace(".", ",")}`;

export default function PriwaWarnkarteLegend({
  sourceDate,
}: PriwaWarnkarteLegendProps) {
  const date = formatPriwaWarnkarteDate(sourceDate);
  if (!date) return null;

  return (
    <section
      data-testid="priwa-warnkarte-legend"
      className="pointer-events-none absolute bottom-20 left-4 z-[55] w-[min(19rem,calc(100%-6rem))] rounded-xl border border-slate-200 bg-white/95 px-3 py-2.5 shadow-lg backdrop-blur md:bottom-5 md:left-1/2 md:w-80 md:-translate-x-1/2"
      aria-label="Warnkarten-Legende"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-semibold text-slate-900">
          Warnkarte {date}
        </span>
        <span className="text-[10px] text-slate-500">Wahrscheinlichkeit</span>
      </div>
      <div className="mt-2 grid grid-cols-10 overflow-hidden rounded-md">
        {PRIWA_WARNKARTE_RED_BANDS.map((color, index) => (
          <span
            key={color}
            className="h-3"
            style={{ backgroundColor: color }}
            title={bandLabel(index)}
            aria-label={bandLabel(index)}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-slate-500">
        <span>0,0–0,1</span>
        <span>0,5</span>
        <span>1,0</span>
      </div>
    </section>
  );
}
