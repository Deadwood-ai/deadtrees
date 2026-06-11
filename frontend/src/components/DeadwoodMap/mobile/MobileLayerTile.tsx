import { CheckOutlined } from "@ant-design/icons";

interface MobileLayerTileProps {
  /** Thumbnail image source */
  thumb: string;
  /** Primary label */
  title: string;
  /** Whether this tile is currently active/selected */
  active: boolean;
  onClick: () => void;
}

/**
 * Tappable thumbnail tile for single-select choices (e.g. base map style)
 * in the mobile settings drawer.
 */
const MobileLayerTile = ({
  thumb,
  title,
  active,
  onClick,
}: MobileLayerTileProps) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`group relative min-w-0 overflow-hidden rounded-[18px] border bg-white p-0 text-left shadow-[0_1px_2px_rgba(15,23,42,0.06)] transition ${
      active
        ? "border-emerald-700 ring-2 ring-emerald-700/20"
        : "border-slate-200 active:border-slate-300"
    }`}
  >
    <span className="relative block aspect-[16/9] w-full bg-slate-100">
      <img
        src={thumb}
        alt=""
        loading="lazy"
        className="absolute inset-0 h-full w-full object-cover transition duration-150 group-active:scale-[1.02]"
      />
      {active && (
        <span className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-emerald-700 text-white shadow-md shadow-emerald-950/20">
          <CheckOutlined className="text-[10px]" />
        </span>
      )}
    </span>
    <span className="block border-t border-slate-100 bg-white px-3 py-2">
      <span
        className={`block truncate text-sm font-semibold ${
          active ? "text-emerald-950" : "text-slate-950"
        }`}
      >
        {title}
      </span>
    </span>
  </button>
);

export default MobileLayerTile;
