import { Progress, Typography } from "antd";
import { palette } from "../../theme/palette";

interface BatchProgressProps {
  layer: "deadwood" | "forest_cover";
  current: number;
  total: number;
  percentage: number;
}

export default function BatchProgressIndicator({ layer, current, total, percentage }: BatchProgressProps) {
  const layerLabel = layer === "deadwood" ? "Deadwood" : "Forest Cover";

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
      <Typography.Text strong className="mb-2 block">
        Copying {layerLabel} Geometries
      </Typography.Text>
      <Progress
        percent={percentage}
        status="active"
        strokeColor={{
          "0%": palette.primary[500],
          "100%": palette.forest[500],
        }}
      />
      <Typography.Text type="secondary" className="mt-2 block text-sm">
        {current} / {total} geometries processed
      </Typography.Text>
    </div>
  );
}
