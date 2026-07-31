import { AimOutlined, PlusOutlined, TableOutlined } from "@ant-design/icons";
import { Button, Select, Switch, Tag, Tooltip } from "antd";

import type {
  IPriwaMatchedMosaic,
  IPriwaUnmatchedMosaic,
} from "./usePriwaMosaicMatches";
import type { IPriwaBefallsgruppe, IPriwaPoint } from "./types";
import type { IPriwaMosaic, PriwaFlightType } from "./usePriwaMosaics";

interface PriwaFlightCardProps {
  mosaic: IPriwaMosaic;
  match?: IPriwaMatchedMosaic;
  unmatched?: IPriwaUnmatchedMosaic;
  groups: IPriwaBefallsgruppe[];
  isVisible: boolean;
  isSelected: boolean;
  isHovered: boolean;
  isClassifyingFlight: boolean;
  onSelect: () => void;
  onSetVisibility: (visible: boolean) => void;
  onSetFlightType: (flightType: PriwaFlightType) => Promise<void>;
  onAssignToGroup: (groupId: string) => Promise<void>;
  onCreateGroup: () => void;
  onZoomToMosaic: () => void;
  onOpenPointInTable: (point: IPriwaPoint) => void;
}

const formatPriwaDate = (value: string | null | undefined) => {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
};

const daysApartLabel = ({ minDaysApart, maxDaysApart }: IPriwaMatchedMosaic) =>
  minDaysApart === maxDaysApart
    ? `${minDaysApart} ${minDaysApart === 1 ? "Tag" : "Tage"} Abstand`
    : `${minDaysApart}–${maxDaysApart} Tage Abstand`;

export default function PriwaFlightCard({
  mosaic,
  match,
  unmatched,
  groups,
  isVisible,
  isSelected,
  isHovered,
  isClassifyingFlight,
  onSelect,
  onSetVisibility,
  onSetFlightType,
  onAssignToGroup,
  onCreateGroup,
  onZoomToMosaic,
  onOpenPointInTable,
}: PriwaFlightCardProps) {
  const isExcluded = mosaic.flightType === "not_priwa";
  const hasConfirmed =
    match?.points.some(({ source }) => source === "confirmed") ?? false;

  return (
    <article
      data-mosaic-id={mosaic.id}
      aria-current={isSelected ? "true" : undefined}
      className={`rounded-md border bg-white px-2 py-2 ${
        isSelected
          ? "border-orange-500 ring-2 ring-orange-200"
          : isHovered
            ? "border-sky-500 ring-2 ring-sky-200"
            : "border-slate-200"
      }`}
      onClick={onSelect}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-slate-950">
            {mosaic.label}
          </div>
          <div className="mt-0.5 text-xs text-slate-500">
            Aufnahme: {formatPriwaDate(mosaic.captureDate) ?? "ohne Datum"} ·
            Upload: {formatPriwaDate(mosaic.createdAt) ?? "ohne Datum"}
          </div>
          {match && (
            <div className="mt-0.5 text-xs font-medium text-emerald-700">
              {match.points.length} Baum
              {match.points.length === 1 ? "" : "e"} · {daysApartLabel(match)}
            </div>
          )}
          {unmatched && (
            <div className="mt-1 rounded bg-amber-50 px-1.5 py-1 text-xs text-amber-800">
              {unmatched.reason}
            </div>
          )}
        </div>
        {!isExcluded && (
          <div className="flex shrink-0 items-center gap-1.5">
            <Tooltip title="Kartengrenze anzeigen">
              <Button
                size="small"
                icon={<AimOutlined />}
                aria-label={`${mosaic.label} auf Karte zeigen`}
                disabled={!mosaic.bbox}
                onClick={(event) => {
                  event.stopPropagation();
                  onZoomToMosaic();
                }}
              />
            </Tooltip>
            <Switch
              size="small"
              checked={isVisible}
              aria-label={`${mosaic.label} anzeigen`}
              onClick={(_, event) => event.stopPropagation()}
              onChange={onSetVisibility}
            />
          </div>
        )}
      </div>

      <div
        className="mt-2 grid gap-1.5"
        onClick={(event) => event.stopPropagation()}
      >
        <Select
          size="small"
          aria-label={`${mosaic.label} klassifizieren`}
          value={mosaic.flightType ?? "unreviewed"}
          loading={isClassifyingFlight}
          disabled={isClassifyingFlight}
          options={[
            { label: "Noch nicht geprüft", value: "unreviewed" },
            { label: "Umfeldbefliegung", value: "umfeldbefliegung" },
            {
              label: "Nicht PRIWA-relevant",
              value: "not_priwa",
              disabled: hasConfirmed,
            },
          ]}
          onChange={(value) =>
            void onSetFlightType(
              value === "unreviewed"
                ? null
                : (value as Exclude<PriwaFlightType, null>),
            )
          }
        />
        {!isExcluded && (
          <div className="flex gap-1.5">
            <Select
              className="min-w-0 flex-1"
              size="small"
              aria-label={`${mosaic.label} einer Befallsgruppe zuordnen`}
              placeholder="Befallsgruppe zuordnen"
              options={groups.map((group) => ({
                label: group.name,
                value: group.id,
              }))}
              onChange={(groupId) => void onAssignToGroup(groupId)}
            />
            <Tooltip title="Neue Befallsgruppe mit dieser Befliegung">
              <Button
                size="small"
                aria-label={`Neue Befallsgruppe für ${mosaic.label}`}
                icon={<PlusOutlined />}
                onClick={onCreateGroup}
              />
            </Tooltip>
          </div>
        )}
      </div>

      {match && match.points.length > 0 && (
        <div className="mt-2 rounded border border-emerald-100 bg-emerald-50/70 px-2 py-1.5">
          <div className="text-[0.7rem] font-semibold uppercase tracking-wide text-emerald-800">
            Zugeordnete Käferbäume
          </div>
          <ul className="mt-1 space-y-0.5">
            {match.points.map(({ point, source }) => (
              <li key={point.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-xs hover:bg-white"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenPointInTable(point);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {point.baumnr ? `Baum ${point.baumnr}` : "Ohne Baumnr"}
                  </span>
                  <Tag
                    className="m-0"
                    color={source === "confirmed" ? "green" : "gold"}
                  >
                    {source === "confirmed" ? "Bestätigt" : "Vorschlag"}
                  </Tag>
                  <span className="shrink-0 tabular-nums text-slate-500">
                    {formatPriwaDate(point.datum) ?? "ohne Datum"}
                  </span>
                  <TableOutlined className="shrink-0 text-emerald-700" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <details className="mt-1 text-xs text-slate-500">
        <summary className="cursor-pointer select-none">Details</summary>
        <div className="mt-1 break-words">
          Dataset {mosaic.id} ·{" "}
          {mosaic.authors.length
            ? mosaic.authors.join(", ")
            : "keine Autorenangabe"}
        </div>
      </details>
    </article>
  );
}
