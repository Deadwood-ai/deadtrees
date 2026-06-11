import { CalendarOutlined } from "@ant-design/icons";

interface MobileTimePillProps {
  year: string;
  active: boolean;
  hidden?: boolean;
  onClick: () => void;
}

/**
 * Floating year pill in the lower-left map corner. Always shows which
 * prediction year the map is displaying and opens the Time sheet on tap —
 * the control labels itself, so no icon decoding is needed.
 */
const MobileTimePill = ({
  year,
  active,
  hidden = false,
  onClick,
}: MobileTimePillProps) => {
  if (hidden) return null;

  return (
    <div className="pointer-events-none absolute bottom-[calc(1rem+env(safe-area-inset-bottom))] left-3 z-[54] md:hidden">
      <button
        type="button"
        aria-label={`Prediction year ${year}. Change time settings`}
        aria-pressed={active}
        onClick={onClick}
        className={`pointer-events-auto flex h-11 items-center gap-1.5 rounded-full border px-3.5 shadow-lg backdrop-blur-md transition ${
          active
            ? "border-emerald-700 bg-emerald-950 text-white shadow-emerald-950/25"
            : "border-white/80 bg-white/95 text-slate-950 shadow-slate-900/15 active:bg-white"
        }`}
      >
        <CalendarOutlined
          className={active ? "text-emerald-200" : "text-slate-500"}
        />
        <span className="text-sm font-semibold leading-none">{year}</span>
      </button>
    </div>
  );
};

export default MobileTimePill;
