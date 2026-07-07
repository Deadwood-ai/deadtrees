import {
  AimOutlined,
  CheckCircleFilled,
  DownloadOutlined,
  EditOutlined,
  EnvironmentOutlined,
  WarningFilled,
} from "@ant-design/icons";
import { Button, Empty, Segmented, Table, Tag } from "antd";
import type { TableProps } from "antd";
import { useMemo, useState } from "react";

import { downloadPriwaPointsCsv } from "./priwaPointCsv";
import {
  getPriwaFundLabel,
  getPriwaPointSourceLabel,
  getPriwaPointTitle,
  isPriwaPointQaCandidate,
} from "./priwaPointQa";
import type { IPriwaPoint } from "./types";

type PriwaPointFilter = "all" | "qa";

interface PriwaPointListPanelProps {
  points: IPriwaPoint[];
  projectName: string;
  isLoading?: boolean;
  onClose: () => void;
  onEditPoint: (point: IPriwaPoint) => void;
  onZoomToPoint: (point: IPriwaPoint) => void;
}

export default function PriwaPointListPanel({
  points,
  projectName,
  isLoading = false,
  onClose,
  onEditPoint,
  onZoomToPoint,
}: PriwaPointListPanelProps) {
  const [filter, setFilter] = useState<PriwaPointFilter>("all");
  const qaPoints = useMemo(
    () => points.filter(isPriwaPointQaCandidate),
    [points],
  );
  const exactCount = points.filter(
    (point) => point.coordinateSource === "qr",
  ).length;
  const visiblePoints = filter === "qa" ? qaPoints : points;
  const pendingSyncCount = points.filter(
    (point) => point.syncStatus && point.syncStatus !== "synced",
  ).length;
  const columns = useMemo<TableProps<IPriwaPoint>["columns"]>(
    () => [
      {
        title: "Status",
        key: "status",
        width: 92,
        render: (_, point) => {
          const isQa = isPriwaPointQaCandidate(point);
          return (
            <div className="flex items-center gap-1.5">
              {isQa ? (
                <WarningFilled className="text-amber-500" />
              ) : (
                <CheckCircleFilled className="text-emerald-600" />
              )}
              <Tag
                className="m-0"
                color={point.coordinateSource === "qr" ? "green" : "gold"}
              >
                {getPriwaPointSourceLabel(point)}
              </Tag>
            </div>
          );
        },
      },
      {
        title: "Baumnr",
        dataIndex: "baumnr",
        width: 110,
        render: (_, point) => getPriwaPointTitle(point),
      },
      {
        title: "Datum",
        dataIndex: "datum",
        width: 118,
      },
      {
        title: "Baumart",
        dataIndex: "baumart",
        width: 150,
      },
      {
        title: "Fund",
        dataIndex: "fund",
        width: 150,
        render: (_, point) => getPriwaFundLabel(point),
      },
      {
        title: "Bohrmehl",
        dataIndex: "bm",
        width: 105,
      },
      {
        title: "Bohrloch",
        dataIndex: "bohrloch",
        width: 150,
      },
      {
        title: "Harz",
        dataIndex: "harz",
        width: 190,
      },
      {
        title: "Grüne Nadeln",
        dataIndex: "grueneNadelnAmBoden",
        width: 130,
      },
      {
        title: "Nadelverfärbung",
        dataIndex: "nadel",
        width: 160,
      },
      {
        title: "Rindenverlust",
        dataIndex: "rinde",
        width: 125,
      },
      {
        title: "Nadelverlust",
        dataIndex: "kv",
        width: 125,
      },
      {
        title: "Name",
        dataIndex: "name",
        width: 150,
      },
      {
        title: "Koordinaten",
        key: "coordinates",
        width: 190,
        render: (_, point) => `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`,
      },
      {
        title: "Kommentar",
        dataIndex: "kom",
        width: 220,
        ellipsis: true,
      },
      {
        title: "",
        key: "actions",
        fixed: "right",
        width: 88,
        render: (_, point) => (
          <div className="flex items-center gap-1">
            <Button
              aria-label="Punkt auf Karte zeigen"
              icon={<AimOutlined />}
              size="small"
              onClick={(event) => {
                event.stopPropagation();
                onZoomToPoint(point);
              }}
            />
            <Button
              aria-label="Punkt bearbeiten"
              icon={<EditOutlined />}
              size="small"
              onClick={(event) => {
                event.stopPropagation();
                onEditPoint(point);
              }}
            />
          </div>
        ),
      },
    ],
    [onEditPoint, onZoomToPoint],
  );
  const emptyDescription =
    isLoading
      ? "Lade Punkte..."
      : filter === "qa" && points.length > 0
        ? "Keine QA-Punkte"
        : "Keine Punkte";

  return (
    <section className="pointer-events-auto absolute inset-x-2 bottom-2 z-[58] flex max-h-[64dvh] flex-col overflow-hidden rounded-md bg-white shadow-xl ring-1 ring-slate-900/10 md:bottom-5 md:left-4 md:right-4 md:top-24 md:max-h-[calc(100dvh-8rem)]">
      <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-950">
            Käferbäume
          </div>
          <div className="truncate text-xs text-slate-500">
            {projectName}
            {pendingSyncCount > 0 ? ` · ${pendingSyncCount} lokal` : ""}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="small"
            icon={<DownloadOutlined />}
            disabled={points.length === 0}
            onClick={() => downloadPriwaPointsCsv(points, projectName)}
          >
            CSV
          </Button>
          <Button size="small" onClick={onClose}>
            Schließen
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-3 border-b border-slate-200 text-center text-xs">
        <div className="px-2 py-2">
          <div className="text-base font-semibold text-slate-950">{points.length}</div>
          <div className="text-slate-500">Gesamt</div>
        </div>
        <div className="border-x border-slate-200 px-2 py-2">
          <div className="text-base font-semibold text-emerald-700">{exactCount}</div>
          <div className="text-slate-500">Exakt</div>
        </div>
        <div className="px-2 py-2">
          <div className="text-base font-semibold text-amber-700">{qaPoints.length}</div>
          <div className="text-slate-500">QA</div>
        </div>
      </div>

      <div className="border-b border-slate-200 px-3 py-2">
        <Segmented
          block
          size="small"
          value={filter}
          onChange={(value) => setFilter(value as PriwaPointFilter)}
          options={[
            { label: "Alle", value: "all" },
            { label: "QA prüfen", value: "qa" },
          ]}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {visiblePoints.length === 0 ? (
          <div className="px-3 py-8">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={emptyDescription}
            />
          </div>
        ) : (
          <Table<IPriwaPoint>
            size="small"
            rowKey="id"
            columns={columns}
            dataSource={visiblePoints}
            pagination={false}
            scroll={{ x: "max-content" }}
            rowClassName="cursor-pointer"
            onRow={(point) => ({
              onClick: () => onZoomToPoint(point),
            })}
          />
        )}
      </div>

      <footer className="flex items-center gap-2 border-t border-slate-200 px-3 py-2 text-xs text-slate-500">
        <EnvironmentOutlined />
        <span>QA markiert geschätzte Lagen oder Punkte ohne Baumnr.</span>
      </footer>
    </section>
  );
}
