import { GeoapifyContext, GeoapifyGeocoderAutocomplete } from "@geoapify/react-geocoder-autocomplete";
import { Button } from "antd";
import { EnvironmentOutlined } from "@ant-design/icons";
import "@geoapify/geocoder-autocomplete/styles/round-borders.css";
import "../DeadwoodMap/geocoder.css";
import { useIsMobile } from "../../hooks/useIsMobile";

interface LocationControlsProps {
  onPlaceSelect: React.Dispatch<React.SetStateAction<number[]>>;
  variant?: "floating-card" | "drawer-inline";
  onLocateMe?: () => void;
  isLocating?: boolean;
}

const LocationControls = ({
  onPlaceSelect,
  variant = "floating-card",
  onLocateMe,
  isLocating = false,
}: LocationControlsProps) => {
  const isDrawerInline = variant === "drawer-inline";
  const isMobile = useIsMobile();

  return (
    <div
      className={`location-controls pointer-events-auto flex w-full flex-col gap-2.5 ${isDrawerInline ? "" : "w-64 rounded-2xl border border-gray-200/60 bg-white/95 p-3.5 shadow-xl backdrop-blur-sm"}`}
    >
      {/* Address Search */}
      {!isDrawerInline && <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-gray-500">Location</div>}
      <GeoapifyContext apiKey={import.meta.env.VITE_GEOPIFY_KEY}>
        <GeoapifyGeocoderAutocomplete
          placeholder="Search location..."
          placeSelect={(place) => place?.bbox && onPlaceSelect(place.bbox)}
        />
      </GeoapifyContext>
      {isMobile && onLocateMe && (
        <Button
          icon={<EnvironmentOutlined />}
          onClick={onLocateMe}
          loading={isLocating}
          className="w-fit rounded-lg px-3 shadow-sm"
        >
          Use current location
        </Button>
      )}
    </div>
  );
};

export default LocationControls;
