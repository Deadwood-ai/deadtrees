import { SearchOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { Button, Drawer, Empty, Input, Tooltip } from "antd";
import { useMemo, useState } from "react";

import { indexPriwaBefallsgruppenByTreeId } from "./priwaBefallsgruppenState";
import PriwaPointCompactList from "./PriwaPointCompactList";
import type { IPriwaBefallsgruppe, IPriwaPoint } from "./types";

interface PriwaMobileFieldToolsProps {
  points: IPriwaPoint[];
  groups: IPriwaBefallsgruppe[];
  onEditPoint: (point: IPriwaPoint) => void;
  onZoomToPoint: (point: IPriwaPoint) => void;
}

export default function PriwaMobileFieldTools({
  points,
  groups,
  onEditPoint,
  onZoomToPoint,
}: PriwaMobileFieldToolsProps) {
  const [isTreeListOpen, setTreeListOpen] = useState(false);
  const [query, setQuery] = useState("");
  const groupByTreeId = useMemo(
    () => indexPriwaBefallsgruppenByTreeId(groups),
    [groups],
  );
  const visiblePoints = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("de");
    if (!normalizedQuery) return points;
    return points.filter((point) =>
      [point.baumnr, point.baumart, point.name, point.datum]
        .join(" ")
        .toLocaleLowerCase("de")
        .includes(normalizedQuery),
    );
  }, [points, query]);

  const showPointOnMap = (point: IPriwaPoint) => {
    onZoomToPoint(point);
    setTreeListOpen(false);
  };

  return (
    <>
      <Tooltip title="Bäume" placement="right">
        <Button
          className="pointer-events-auto shadow-md md:hidden"
          shape="circle"
          size="large"
          icon={<UnorderedListOutlined />}
          onClick={() => setTreeListOpen(true)}
          aria-label="Baumliste öffnen"
          aria-pressed={isTreeListOpen}
        />
      </Tooltip>

      <Drawer
        title={`Käferbäume (${points.length})`}
        placement="bottom"
        height="78dvh"
        open={isTreeListOpen}
        onClose={() => setTreeListOpen(false)}
        rootClassName="priwa-layer-sheet-root"
        className="md:hidden"
        styles={{
          header: { padding: "12px 16px" },
          body: {
            padding: "0 0 calc(env(safe-area-inset-bottom, 0px) + 16px)",
            overflow: "hidden",
          },
        }}
      >
        <div className="flex h-full min-h-0 flex-col">
          <div className="border-b border-slate-200 p-3">
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="Baumnummer, Baumart oder Name"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {visiblePoints.length > 0 ? (
              <PriwaPointCompactList
                points={visiblePoints}
                groupByTreeId={groupByTreeId}
                onEditPoint={onEditPoint}
                onZoomToPoint={showPointOnMap}
              />
            ) : (
              <Empty
                className="py-12"
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="Keine passenden Bäume"
              />
            )}
          </div>
        </div>
      </Drawer>
    </>
  );
}
