import { CloseOutlined } from "@ant-design/icons";
import { Button } from "antd";

import { PRIWA_WARNKARTE_RED_BANDS } from "./createPriwaWarnkarteLayer";
import { formatPriwaWarnkarteDate } from "./priwaWarnkartePresentation";

interface PriwaWarnkarteLegendProps {
  sourceDate: string | null;
  onDismiss?: () => void;
}

const bandLabel = (index: number) =>
  index === 0
    ? "Wahrscheinlichkeit 0,0 bis 0,1"
    : `Wahrscheinlichkeit ${((index + 1) / 10).toFixed(1).replace(".", ",")}`;

export default function PriwaWarnkarteLegend({
  sourceDate,
  onDismiss,
}: PriwaWarnkarteLegendProps) {
  const date = formatPriwaWarnkarteDate(sourceDate);
  if (!date) return null;

  return (
    <section
      data-testid="priwa-warnkarte-legend"
      className="pointer-events-none absolute bottom-20 left-4 z-[55] w-[min(19rem,calc(100%-6rem))] rounded-xl border border-slate-200 bg-white/95 px-3 py-2.5 shadow-lg backdrop-blur min-[992px]:bottom-5 min-[992px]:left-1/2 min-[992px]:w-80 min-[992px]:-translate-x-1/2"
      aria-label="Warnkarten-Legende"
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-slate-900">
          Warnkarte {date}
        </span>
        <span className="ml-auto text-[10px] text-slate-500">
          Wahrscheinlichkeit
        </span>
        {onDismiss && (
          <Button
            type="text"
            size="small"
            shape="circle"
            icon={<CloseOutlined />}
            className="pointer-events-auto -mr-1"
            aria-label="Warnkarten-Legende schließen"
            onClick={onDismiss}
          />
        )}
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
