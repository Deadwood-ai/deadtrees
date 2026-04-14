import { useState } from "react";
import { Modal, Spin, Alert, Segmented } from "antd";
import {
  AreaChartOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  MinusOutlined,
} from "@ant-design/icons";
import { Line } from "@ant-design/charts";
import type {
  PolygonStatsResponse,
  YearStats,
} from "../../hooks/usePolygonStats";
import { palette } from "../../theme/palette";
import { useIsMobile } from "../../hooks/useIsMobile";

type ViewMode = "threshold" | "continuous";

interface PolygonStatsModalProps {
  open: boolean;
  onClose: () => void;
  data: PolygonStatsResponse | null;
  loading: boolean;
  error: string | null;
}

function computeChange(
  first: number | null,
  last: number | null,
): { pct: number; direction: "up" | "down" | "flat" } | null {
  if (first === null || last === null || first === 0) return null;
  const pct = ((last - first) / first) * 100;
  const direction = pct > 0.5 ? "up" : pct < -0.5 ? "down" : "flat";
  return { pct, direction };
}

const ChangeIndicator = ({
  change,
}: {
  change: { pct: number; direction: "up" | "down" | "flat" };
}) => {
  const icon =
    change.direction === "up" ? (
      <ArrowUpOutlined />
    ) : change.direction === "down" ? (
      <ArrowDownOutlined />
    ) : (
      <MinusOutlined />
    );
  const color =
    change.direction === "up"
      ? palette.forest[600]
      : change.direction === "down"
        ? palette.state.error
        : palette.neutral[500];
  return (
    <span style={{ color, fontSize: 13, fontWeight: 500 }}>
      {icon} {change.pct > 0 ? "+" : ""}
      {change.pct.toFixed(1)}%
      <span style={{ color: palette.neutral[500], fontWeight: 400 }}>
        {" "}
        since 2017
      </span>
    </span>
  );
};

function getTreeCoverHa(s: YearStats, mode: ViewMode): number | null {
  return mode === "threshold"
    ? s.tree_cover_area_ha
    : s.tree_cover_continuous_area_ha;
}

function getDeadwoodHa(s: YearStats, mode: ViewMode): number | null {
  return mode === "threshold"
    ? s.deadwood_area_ha
    : s.deadwood_continuous_area_ha;
}

const VIEW_DESCRIPTIONS: Record<
  ViewMode,
  (treeThreshold: number, deadwoodThreshold: number) => string
> = {
  threshold: (tree, dead) =>
    `Pixels above a cover threshold are counted as fully covered (tree cover >${tree}%, deadwood >${dead}%). Best for detecting clearings and mortality patches.`,
  continuous: () =>
    "Each pixel contributes proportionally to its cover value. Captures gradual canopy changes but is sensitive to prediction variability.",
};

const PolygonStatsModal = ({
  open,
  onClose,
  data,
  loading,
  error,
}: PolygonStatsModalProps) => {
  const [viewMode, setViewMode] = useState<ViewMode>("threshold");
  const isMobile = useIsMobile();
  const treeThreshold = data?.tree_cover_threshold_pct ?? 10;
  const deadwoodThreshold = data?.deadwood_threshold_pct ?? 50;

  const chartData =
    data?.stats
      .filter(
        (s) =>
          getTreeCoverHa(s, viewMode) !== null ||
          getDeadwoodHa(s, viewMode) !== null,
      )
      .flatMap((s) => {
        const items: { year: string; value: number; category: string }[] = [];
        const treeHa = getTreeCoverHa(s, viewMode);
        const deadHa = getDeadwoodHa(s, viewMode);
        if (treeHa !== null) {
          items.push({
            year: String(s.year),
            value: treeHa,
            category: "Tree Cover",
          });
        }
        if (deadHa !== null) {
          items.push({
            year: String(s.year),
            value: deadHa,
            category: "Standing Deadwood",
          });
        }
        return items;
      }) ?? [];

  const firstStats = data?.stats[0] ?? null;
  const latestStats = data?.stats[data.stats.length - 1] ?? null;
  const treeCoverChange = computeChange(
    firstStats ? getTreeCoverHa(firstStats, viewMode) : null,
    latestStats ? getTreeCoverHa(latestStats, viewMode) : null,
  );
  const deadwoodChange = computeChange(
    firstStats ? getDeadwoodHa(firstStats, viewMode) : null,
    latestStats ? getDeadwoodHa(latestStats, viewMode) : null,
  );

  const latestTreeHa = latestStats
    ? getTreeCoverHa(latestStats, viewMode)
    : null;
  const latestDeadHa = latestStats
    ? getDeadwoodHa(latestStats, viewMode)
    : null;

  return (
    <Modal
      title={
        <div className="flex items-center gap-2">
          <AreaChartOutlined style={{ color: palette.primary[500] }} />
          <span>
            Area Statistics{" "}
            <span
              style={{
                color: palette.neutral[500],
                fontWeight: 400,
                fontSize: 13,
              }}
            >
              (experimental)
            </span>
          </span>
        </div>
      }
      open={open}
      onCancel={onClose}
      footer={null}
      width={isMobile ? "calc(100vw - 8px)" : 720}
      destroyOnClose
      centered={!isMobile}
      styles={{
        body: {
          maxHeight: isMobile ? "70vh" : "75vh",
          overflowY: "auto",
          overflowX: "hidden",
          padding: isMobile ? 10 : 24,
        },
      }}
    >
      {loading && (
        <div className="flex items-center justify-center py-16">
          <Spin size="large" tip="Computing statistics from COG data..." />
        </div>
      )}

      {error && (
        <Alert
          type="error"
          message="Error"
          description={error}
          showIcon
          className="mb-4"
        />
      )}

      {data && !loading && (
        <div className="flex flex-col gap-4">
          {/* View mode toggle + description */}
          <div className="flex flex-col gap-2">
            <Segmented
              block={isMobile}
              size={isMobile ? "middle" : "middle"}
              value={viewMode}
              onChange={(v) => setViewMode(v as ViewMode)}
              style={{ alignSelf: isMobile ? "stretch" : "flex-start" }}
              options={[
                {
                  value: "threshold",
                  label: isMobile
                    ? "Affected Area"
                    : "Affected Area (threshold)",
                },
                {
                  value: "continuous",
                  label: isMobile
                    ? "Canopy Cover"
                    : "Canopy Cover (continuous)",
                },
              ]}
            />
            <div
              className="text-xs leading-5"
              style={{ color: palette.neutral[500] }}
            >
              {VIEW_DESCRIPTIONS[viewMode](treeThreshold, deadwoodThreshold)}
            </div>
          </div>

          {/* Summary stats */}
          <div
            className={`grid rounded-lg ${isMobile ? "grid-cols-3 gap-2 p-3" : "grid-cols-3 gap-4 p-4"}`}
            style={{
              background: palette.neutral[50],
              border: `1px solid ${palette.neutral[100]}`,
            }}
          >
            {/* Area */}
            <div>
              <div className="text-xs" style={{ color: palette.neutral[500] }}>
                Selected Area
              </div>
              <div
                className={isMobile ? "text-base font-semibold" : "text-lg font-semibold"}
                style={{ color: palette.neutral[800] }}
              >
                {data.polygon_area_km2.toFixed(2)} km²
              </div>
              {viewMode === "continuous" &&
                latestStats?.tree_cover_mean_pct != null && (
                  <span
                    style={{
                      color: palette.neutral[500],
                      fontSize: isMobile ? 11 : 12,
                    }}
                  >
                    {latestStats.tree_cover_mean_pct.toFixed(1)}% mean cover
                  </span>
                )}
              {viewMode === "threshold" && (
                <span
                  style={{
                    color: palette.neutral[500],
                    fontSize: isMobile ? 11 : 12,
                  }}
                >
                  tree &gt;{treeThreshold}%, deadwood &gt;{deadwoodThreshold}%
                </span>
              )}
            </div>
            {/* Tree Cover */}
            <div>
              <div className="text-xs" style={{ color: palette.forest[600] }}>
                Tree Cover
              </div>
              <div
                className={isMobile ? "text-base font-semibold" : "text-lg font-semibold"}
                style={{ color: palette.forest[600] }}
              >
                {latestTreeHa !== null ? `${latestTreeHa.toFixed(1)} ha` : "–"}
              </div>
              {treeCoverChange && <ChangeIndicator change={treeCoverChange} />}
            </div>
            {/* Standing Deadwood */}
            <div>
              <div className="text-xs" style={{ color: palette.deadwood[500] }}>
                Standing Deadwood
              </div>
              <div
                className={isMobile ? "text-base font-semibold" : "text-lg font-semibold"}
                style={{ color: palette.deadwood[500] }}
              >
                {latestDeadHa !== null ? `${latestDeadHa.toFixed(1)} ha` : "–"}
              </div>
              {deadwoodChange && <ChangeIndicator change={deadwoodChange} />}
            </div>
          </div>

          {/* No data message */}
          {chartData.length === 0 && (
            <Alert
              type="info"
              message="No coverage data available"
              description="The drawn polygon does not overlap with any coverage data. Try drawing in an area where the tree cover / deadwood layers are visible on the map."
              showIcon
            />
          )}

          {/* Coverage area over time chart */}
          {chartData.length > 0 && (
            <>
              <Line
                data={chartData}
                xField="year"
                yField="value"
                colorField="category"
                height={isMobile ? 220 : 300}
                autoFit
                shapeField="smooth"
                style={{ lineWidth: 2.5 }}
                point={{ shapeField: "circle", sizeField: 4 }}
                scale={{
                  color: {
                    range: [palette.forest[600], palette.deadwood[500]],
                  },
                }}
                axis={{
                  y: { title: "Area (ha)", titleFontSize: 12 },
                  x: { title: false },
                }}
                legend={{ color: { position: "top" } }}
                area={{
                  style: { fillOpacity: 0.15 },
                }}
              />
              {viewMode === "continuous" && (
                <div
                  className="text-xs"
                  style={{ color: palette.neutral[500] }}
                >
                  Note: 2017 and 2018 values may show systematic underestimation
                  of tree cover.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Modal>
  );
};

export default PolygonStatsModal;
