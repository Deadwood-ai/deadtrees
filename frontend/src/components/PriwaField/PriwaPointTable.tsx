import {
  AimOutlined,
  CheckCircleFilled,
  EditOutlined,
  WarningFilled,
} from "@ant-design/icons";
import { Button, Table, Tag } from "antd";
import type { TableProps } from "antd";
import { useMemo } from "react";

import {
  getPriwaFundLabel,
  getPriwaPointSourceLabel,
  getPriwaPointTitle,
  isPriwaPointQaCandidate,
} from "./priwaPointQa";
import type { IPriwaPoint } from "./types";

interface PriwaPointTableProps {
  points: IPriwaPoint[];
  focusedPointId?: string | null;
  onEditPoint: (point: IPriwaPoint) => void;
  onZoomToPoint: (point: IPriwaPoint) => void;
}

export default function PriwaPointTable({
  points,
  focusedPointId = null,
  onEditPoint,
  onZoomToPoint,
}: PriwaPointTableProps) {
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
      { title: "Datum", dataIndex: "datum", width: 118 },
      { title: "Baumart", dataIndex: "baumart", width: 150 },
      {
        title: "Fund",
        dataIndex: "fund",
        width: 150,
        render: (_, point) => getPriwaFundLabel(point),
      },
      { title: "Bohrmehl", dataIndex: "bm", width: 105 },
      { title: "Bohrloch", dataIndex: "bohrloch", width: 150 },
      { title: "Harz", dataIndex: "harz", width: 190 },
      {
        title: "Grüne Nadeln",
        dataIndex: "grueneNadelnAmBoden",
        width: 130,
      },
      { title: "Nadelverfärbung", dataIndex: "nadel", width: 160 },
      { title: "Rindenverlust", dataIndex: "rinde", width: 125 },
      { title: "Nadelverlust", dataIndex: "kv", width: 125 },
      { title: "Name", dataIndex: "name", width: 150 },
      {
        title: "Koordinaten",
        key: "coordinates",
        width: 190,
        render: (_, point) =>
          `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`,
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

  return (
    <Table<IPriwaPoint>
      size="small"
      rowKey="id"
      columns={columns}
      dataSource={points}
      pagination={false}
      scroll={{ x: "max-content" }}
      rowClassName={(point) =>
        point.id === focusedPointId
          ? "priwa-point-table-row-focused cursor-pointer"
          : "cursor-pointer"
      }
      onRow={(point) => ({ onClick: () => onZoomToPoint(point) })}
    />
  );
}
