import {
  EnvironmentOutlined,
  PlusOutlined,
  SearchOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import { Button, Drawer, Empty, Input } from "antd";
import { useMemo, useState } from "react";

import { indexPriwaBefallsgruppenByTreeId } from "./priwaBefallsgruppenState";
import PriwaPointCompactList from "./PriwaPointCompactList";
import type { IPriwaBefallsgruppe, IPriwaPoint, PriwaBaseLayer } from "./types";

interface PriwaMobileFieldToolsProps {
  points: IPriwaPoint[];
  groups: IPriwaBefallsgruppe[];
  baseLayer: PriwaBaseLayer;
  onBaseLayerChange: (baseLayer: PriwaBaseLayer) => void;
  onAddPoint: () => void;
  onEditPoint: (point: IPriwaPoint) => void;
  onZoomToPoint: (point: IPriwaPoint) => void;
}

export default function PriwaMobileFieldTools({
  points,
  groups,
  baseLayer,
  onBaseLayerChange,
  onAddPoint,
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
      <nav
        aria-label="PRIWA Feldaktionen"
        className="pointer-events-auto absolute bottom-3 left-3 right-3 z-[56] grid grid-cols-[1fr_1.35fr_1fr] gap-2 rounded-2xl border border-slate-200 bg-white/95 p-2 shadow-xl backdrop-blur md:hidden"
        style={{
          paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 8px)",
        }}
      >
        <Button
          className="h-12"
          icon={<UnorderedListOutlined />}
          onClick={() => setTreeListOpen(true)}
        >
          Bäume
        </Button>
        <Button
          className="h-12"
          type="primary"
          icon={<PlusOutlined />}
          onClick={onAddPoint}
        >
          Aufnehmen
        </Button>
        <Button
          className="h-12"
          icon={<EnvironmentOutlined />}
          onClick={() =>
            onBaseLayerChange(baseLayer === "aerial" ? "topographic" : "aerial")
          }
        >
          {baseLayer === "aerial" ? "Karte" : "Luftbild"}
        </Button>
      </nav>

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
