import { Radio } from "antd";

const mapStyleOptions = [
  { label: "Satellite", value: "satellite-streets-v12" },
  { label: "Streets", value: "streets-v12" },
];

const MapStyleSwitchButtons = ({ mapStyle, onChange }: { mapStyle: string; onChange: (next: string) => void }) => {
  return (
    <Radio.Group
      value={mapStyle}
      onChange={(e) => onChange(e.target.value)}
      optionType="button"
      options={mapStyleOptions}
    />
  );
};

export default MapStyleSwitchButtons;
