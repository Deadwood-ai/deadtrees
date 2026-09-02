import type { ReactNode } from "react";
import { Switch } from "antd";

interface MobileLayerRowProps {
  thumb?: string;
  icon?: ReactNode;
  title: string;
  description?: string;
  checked: boolean;
  swatchColor?: string;
  count?: number;
  secondaryAction?: ReactNode;
  toggleLabel?: string;
  onChange: (checked: boolean) => void;
}

const MobileLayerRow = ({
  thumb,
  icon,
  title,
  description,
  checked,
  swatchColor,
  count,
  secondaryAction,
  toggleLabel,
  onChange,
}: MobileLayerRowProps) => (
  <div
    className="flex min-h-14 cursor-pointer items-center gap-3 rounded-2xl border border-slate-200 bg-white p-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.06)] transition active:bg-slate-50"
    onClick={() => onChange(!checked)}
  >
    {(thumb || icon) && (
      <span className="relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-slate-100 text-lg text-amber-700 ring-1 ring-inset ring-slate-900/10">
        {thumb ? (
          <img
            src={thumb}
            alt=""
            loading="lazy"
            aria-hidden="true"
            className={`h-full w-full object-cover transition ${
              checked ? "" : "opacity-40 grayscale"
            }`}
          />
        ) : (
          icon
        )}
      </span>
    )}
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
    {secondaryAction && (
      <span onClick={(event) => event.stopPropagation()}>
        {secondaryAction}
      </span>
    )}
    <span onClick={(event) => event.stopPropagation()}>
      <Switch
        checked={checked}
        onChange={onChange}
        aria-label={toggleLabel ?? `Show ${title}`}
      />
    </span>
  </div>
);

export default MobileLayerRow;
