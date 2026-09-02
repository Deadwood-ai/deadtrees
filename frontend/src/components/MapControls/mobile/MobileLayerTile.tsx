import { CheckOutlined } from "@ant-design/icons";

interface MobileLayerTileProps {
  thumb: string;
  title: string;
  active: boolean;
  onClick: () => void;
}

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
    className={`group relative min-w-0 overflow-hidden rounded-2xl border bg-slate-100 p-0 text-left shadow-[0_1px_2px_rgba(15,23,42,0.06)] transition ${
      active
        ? "border-emerald-700 ring-2 ring-emerald-700/20"
        : "border-slate-200 active:border-slate-300"
    }`}
  >
    <span className="relative block aspect-[2/1] w-full">
      <img
        src={thumb}
        alt=""
        loading="lazy"
        className="absolute inset-0 h-full w-full object-cover transition duration-150 group-active:scale-[1.02]"
      />
      <span className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-slate-950/75 to-transparent" />
      <span className="absolute bottom-2 left-2.5 right-9 block truncate text-sm font-semibold text-white drop-shadow-sm">
        {title}
      </span>
      {active && (
        <span className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-emerald-700 text-white shadow-md shadow-emerald-950/20">
          <CheckOutlined className="text-[10px]" />
        </span>
      )}
    </span>
  </button>
);

export default MobileLayerTile;
