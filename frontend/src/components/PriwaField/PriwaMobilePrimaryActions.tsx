import {
  AimOutlined,
  EnvironmentOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import { Button, Tooltip } from "antd";

interface PriwaMobilePrimaryActionsProps {
  hidden: boolean;
  isLocating: boolean;
  locationActive: boolean;
  locationLabel: string;
  onAddPoint: () => void;
  onLocate: () => void;
}

const actionClass =
  "pointer-events-auto !flex !h-[52px] !w-[52px] !min-w-[52px] !items-center !justify-center shadow-lg shadow-slate-950/20";

export default function PriwaMobilePrimaryActions({
  hidden,
  isLocating,
  locationActive,
  locationLabel,
  onAddPoint,
  onLocate,
}: PriwaMobilePrimaryActionsProps) {
  if (hidden) return null;

  return (
    <div
      className="pointer-events-none absolute right-4 z-[55] flex flex-col gap-2.5 min-[992px]:hidden"
      style={{
        bottom: "max(20px, calc(env(safe-area-inset-bottom, 0px) + 20px))",
      }}
    >
      <Tooltip title="Käferbaum aufnehmen" placement="left">
        <Button
          className={actionClass}
          shape="circle"
          icon={<PlusOutlined />}
          aria-label="Käferbaum aufnehmen"
          onClick={onAddPoint}
        />
      </Tooltip>
      <Tooltip title={locationLabel} placement="left">
        <Button
          className={actionClass}
          type={locationActive ? "primary" : "default"}
          shape="circle"
          icon={isLocating ? <AimOutlined spin /> : <EnvironmentOutlined />}
          aria-label="Aktuelle Position aktivieren"
          aria-pressed={locationActive}
          onClick={onLocate}
        />
      </Tooltip>
    </div>
  );
}
