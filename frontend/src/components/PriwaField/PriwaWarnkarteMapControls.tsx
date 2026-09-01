import {
  EyeInvisibleOutlined,
  EyeOutlined,
  FullscreenOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { Button, Tooltip } from "antd";

interface PriwaWarnkarteVisibilityControlProps {
  hasOverlay: boolean;
  isVisible: boolean;
  onToggle: () => void;
}

export function PriwaWarnkarteVisibilityControl({
  hasOverlay,
  isVisible,
  onToggle,
}: PriwaWarnkarteVisibilityControlProps) {
  const label = isVisible ? "Warnkarte ausblenden" : "Warnkarte einblenden";

  if (!hasOverlay) return null;

  return (
    <Tooltip title={label} placement="right">
      <Button
        className="pointer-events-auto shadow-md"
        type={isVisible ? "primary" : "default"}
        shape="circle"
        size="large"
        icon={isVisible ? <EyeOutlined /> : <EyeInvisibleOutlined />}
        aria-label={label}
        aria-pressed={isVisible}
        onClick={onToggle}
      />
    </Tooltip>
  );
}

interface PriwaWarnkarteZoomControlProps {
  onZoom: () => void;
}

export function PriwaWarnkarteZoomControl({
  onZoom,
}: PriwaWarnkarteZoomControlProps) {
  return (
    <Tooltip title="Zur Warnkarte zoomen" placement="right">
      <Button
        className="pointer-events-auto shadow-md"
        shape="circle"
        size="large"
        icon={<FullscreenOutlined />}
        aria-label="Zur Warnkarte zoomen"
        onClick={onZoom}
      />
    </Tooltip>
  );
}

interface PriwaWarnkarteAdminControlProps {
  isOpen: boolean;
  onToggle: () => void;
}

export function PriwaWarnkarteAdminControl({
  isOpen,
  onToggle,
}: PriwaWarnkarteAdminControlProps) {
  const label = isOpen
    ? "Warnkarten-Verwaltung schließen"
    : "Warnkarte verwalten";

  return (
    <Tooltip title={label} placement="right">
      <Button
        className="pointer-events-auto shadow-md"
        type={isOpen ? "primary" : "default"}
        shape="circle"
        size="large"
        icon={<WarningOutlined />}
        aria-label={label}
        aria-pressed={isOpen}
        onClick={onToggle}
      />
    </Tooltip>
  );
}
