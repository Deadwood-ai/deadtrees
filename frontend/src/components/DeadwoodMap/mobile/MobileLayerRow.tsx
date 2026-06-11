import { Switch } from "antd";

interface MobileLayerRowProps {
  /** Small square thumbnail illustrating the layer */
  thumb: string;
  title: string;
  description?: string;
  checked: boolean;
  /** Legend swatch tying the row to the layer's color on the map */
  swatchColor?: string;
  /** Optional count shown after the title (e.g. number of points) */
  count?: number;
  onChange: (checked: boolean) => void;
}

/**
 * Compact toggleable row for a data layer in the mobile settings drawer.
 * The whole row is tappable; the switch is the visible state affordance
 * and remains the keyboard/screen-reader control.
 */
const MobileLayerRow = ({
  thumb,
  title,
  description,
  checked,
  swatchColor,
  count,
  onChange,
}: MobileLayerRowProps) => (
  <div
    className="flex min-h-[60px] cursor-pointer items-center gap-3 rounded-[18px] border border-slate-200 bg-white p-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.06)] transition active:bg-slate-50"
    onClick={() => onChange(!checked)}
  >
    <span className="relative h-11 w-11 shrink-0 overflow-hidden rounded-xl bg-slate-100 ring-1 ring-inset ring-slate-900/10">
      <img
        src={thumb}
        alt=""
        loading="lazy"
        aria-hidden="true"
        className={`h-full w-full object-cover transition ${
          checked ? "" : "opacity-40 grayscale"
        }`}
      />
    </span>
    <span className="min-w-0 flex-1">
      <span className="flex items-center gap-1.5">
        {swatchColor && (
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: swatchColor }}
          />
        )}
        <span className="truncate text-sm font-semibold text-slate-950">
          {title}
        </span>
        {count !== undefined && count > 0 && (
          <span className="shrink-0 text-sm text-slate-500">({count})</span>
        )}
      </span>
      {description && (
        <span className="mt-0.5 block truncate text-xs text-slate-500">
          {description}
        </span>
      )}
    </span>
    <span onClick={(event) => event.stopPropagation()}>
      <Switch
        checked={checked}
        onChange={onChange}
        aria-label={`Show ${title}`}
      />
    </span>
  </div>
);

export default MobileLayerRow;
