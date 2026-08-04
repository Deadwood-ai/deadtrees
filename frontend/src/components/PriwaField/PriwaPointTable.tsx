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
import { comparePriwaTableText } from "./priwaPointTableData";
import type { IPriwaBefallsgruppe, IPriwaPoint } from "./types";

interface PriwaPointTableProps {
  points: IPriwaPoint[];
  groupByTreeId: Record<string, IPriwaBefallsgruppe>;
  confirmedFlightLabelsByTreeId: Record<string, string[]>;
  focusedPointId?: string | null;
  getScrollContainer: () => Window | HTMLElement;
  onEditPoint: (point: IPriwaPoint) => void;
  onZoomToPoint: (point: IPriwaPoint) => void;
}

export default function PriwaPointTable({
  points,
  groupByTreeId,
  confirmedFlightLabelsByTreeId,
  focusedPointId = null,
  getScrollContainer,
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
        sorter: (left, right) =>
          comparePriwaTableText(left.baumnr, right.baumnr),
        render: (_, point) => getPriwaPointTitle(point),
      },
      {
        title: "Datum",
        dataIndex: "datum",
        width: 118,
        sorter: (left, right) => left.datum.localeCompare(right.datum),
      },
      {
        title: "Befallsgruppe",
        key: "befallsgruppe",
        width: 180,
        sorter: (left, right) =>
          comparePriwaTableText(
            groupByTreeId[left.id]?.name,
            groupByTreeId[right.id]?.name,
          ),
        render: (_, point) => {
          const group = groupByTreeId[point.id];
          return group ? (
            <Tag className="m-0" color="green">
              {group.name}
            </Tag>
          ) : (
            <span className="text-slate-400">Nicht zugeordnet</span>
          );
        },
      },
      {
        title: "Bestätigte Befliegungsdateien",
        key: "flightFilenames",
        width: 280,
        sorter: (left, right) =>
          comparePriwaTableText(
            confirmedFlightLabelsByTreeId[left.id]?.join(" | "),
            confirmedFlightLabelsByTreeId[right.id]?.join(" | "),
          ),
        render: (_, point) => {
          const labels = confirmedFlightLabelsByTreeId[point.id] ?? [];
          const filenames = labels.join(" | ");
          return filenames ? (
            <span className="block max-w-[17rem] truncate" title={filenames}>
              {filenames}
            </span>
          ) : (
            <span className="text-slate-400">—</span>
          );
        },
      },
      {
        title: "Baumart",
        dataIndex: "baumart",
        width: 150,
        sorter: (left, right) =>
          comparePriwaTableText(left.baumart, right.baumart),
      },
      {
        title: "Fund",
        dataIndex: "fund",
        width: 150,
        sorter: (left, right) =>
          comparePriwaTableText(
            getPriwaFundLabel(left),
            getPriwaFundLabel(right),
          ),
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
      {
        title: "Name",
        dataIndex: "name",
        width: 150,
        sorter: (left, right) => comparePriwaTableText(left.name, right.name),
      },
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
    [confirmedFlightLabelsByTreeId, groupByTreeId, onEditPoint, onZoomToPoint],
  );

  return (
    <Table<IPriwaPoint>
      size="small"
      rowKey="id"
      columns={columns}
      dataSource={points}
      pagination={false}
      scroll={{ x: "max-content" }}
      sticky={{ getContainer: getScrollContainer }}
      rowClassName={(point) =>
        point.id === focusedPointId
          ? "priwa-point-table-row-focused cursor-pointer"
          : "cursor-pointer"
      }
      onRow={(point) => ({ onClick: () => onZoomToPoint(point) })}
    />
  );
}
