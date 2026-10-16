import {
  LeftOutlined,
  MinusOutlined,
  PlusOutlined,
  RightOutlined,
} from "@ant-design/icons";
import { Button, Space } from "antd";

/** Minus / value / plus / reset, for the tile size and the linked image zoom. */
export function BenchmarkZoomControl({
  value,
  min,
  max,
  label,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  label: string;
  onChange: (value: number) => void;
}) {
  return (
    <Space.Compact size="small" aria-label={label}>
      <Button
        icon={<MinusOutlined />}
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 0.5))}
        aria-label={`${label}: smaller`}
      />
      <Button className="pointer-events-none min-w-12 tabular-nums">
        {value.toFixed(1)}×
      </Button>
      <Button
        icon={<PlusOutlined />}
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 0.5))}
        aria-label={`${label}: larger`}
      />
      <Button disabled={value === min} onClick={() => onChange(min)}>
        Reset
      </Button>
    </Space.Compact>
  );
}

/** Previous / position / next, for image sequences. */
export function BenchmarkPager({
  position,
  label,
  canPrevious,
  canNext,
  onPrevious,
  onNext,
}: {
  position: string;
  label: string;
  canPrevious: boolean;
  canNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <Space size={8} align="center">
      <Button
        size="small"
        icon={<LeftOutlined />}
        disabled={!canPrevious}
        onClick={onPrevious}
        aria-label={`Previous ${label}`}
      />
      <span className="min-w-14 text-center text-[13px] tabular-nums text-gray-600">
        {position}
      </span>
      <Button
        size="small"
        icon={<RightOutlined />}
        disabled={!canNext}
        onClick={onNext}
        aria-label={`Next ${label}`}
      />
    </Space>
  );
}
