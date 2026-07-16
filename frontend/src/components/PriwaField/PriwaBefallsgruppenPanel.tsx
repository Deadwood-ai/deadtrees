import { AimOutlined, EditOutlined, PlusOutlined } from "@ant-design/icons";
import { Button, Empty, Tag, message } from "antd";
import { useEffect, useMemo, useState } from "react";

import PriwaBefallsgruppeEditor, {
  type IPriwaBefallsgruppeEditorDraft,
} from "./PriwaBefallsgruppeEditor";
import { arePriwaBefallsgruppenReady } from "./priwaBefallsgruppenState";
import {
  suggestPriwaBefallsgruppen,
  type IPriwaBefallsgruppeSuggestion,
} from "./priwaBefallsgruppeSuggestions";
import type {
  IPriwaBefallsgruppe,
  IPriwaBefallsgruppeSaveInput,
  IPriwaPoint,
} from "./types";
import type { IPriwaMosaic } from "./usePriwaMosaics";

interface PriwaBefallsgruppenPanelProps {
  points: IPriwaPoint[];
  mosaics: IPriwaMosaic[];
  groups: IPriwaBefallsgruppe[];
  mosaicIdByPointId: Record<string, string>;
  isMobile: boolean;
  isLoading: boolean;
  isSaving: boolean;
  errorMessage: string | null;
  onClose: () => void;
  onSave: (input: IPriwaBefallsgruppeSaveInput) => Promise<void>;
  onDelete: (groupId: string) => Promise<void>;
  onZoomToTrees: (treeIds: string[]) => void;
}

const formatDate = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
};

export default function PriwaBefallsgruppenPanel({
  points,
  mosaics,
  groups,
  mosaicIdByPointId,
  isMobile,
  isLoading,
  isSaving,
  errorMessage,
  onClose,
  onSave,
  onDelete,
  onZoomToTrees,
}: PriwaBefallsgruppenPanelProps) {
  const [draft, setDraft] = useState<IPriwaBefallsgruppeEditorDraft | null>(
    null,
  );
  const isGroupStateReady = arePriwaBefallsgruppenReady(
    isLoading,
    errorMessage,
  );
  const confirmedTreeIds = useMemo(
    () => new Set(groups.flatMap((group) => group.treeIds)),
    [groups],
  );
  const suggestions = useMemo(
    () =>
      isGroupStateReady
        ? suggestPriwaBefallsgruppen(points, confirmedTreeIds)
        : [],
    [confirmedTreeIds, isGroupStateReady, points],
  );

  useEffect(() => {
    if (!isGroupStateReady) setDraft(null);
  }, [isGroupStateReady]);

  const openSuggestion = (
    suggestion: IPriwaBefallsgruppeSuggestion,
    index: number,
  ) => {
    const datasetIds = Array.from(
      new Set(
        suggestion.treeIds
          .map((treeId) => mosaicIdByPointId[treeId])
          .filter((id): id is string => !!id),
      ),
    );
    setDraft({
      name: `Befallsgruppe ${formatDate(suggestion.maxDate)}-${index + 1}`,
      origin: "suggestion",
      confidence: suggestion.confidence,
      suggestionReason: suggestion.reason,
      algorithmVersion: suggestion.algorithmVersion,
      treeIds: suggestion.treeIds,
      datasetIds,
    });
  };

  const save = async (input: IPriwaBefallsgruppeSaveInput) => {
    if (!isGroupStateReady) {
      message.error(
        "Befallsgruppen können erst nach erfolgreichem Laden bearbeitet werden.",
      );
      return;
    }
    try {
      await onSave(input);
      message.success("Befallsgruppe gespeichert");
      setDraft(null);
    } catch (error) {
      message.error(
        error instanceof Error
          ? error.message
          : "Befallsgruppe konnte nicht gespeichert werden.",
      );
    }
  };
  const remove = async (groupId: string) => {
    if (!isGroupStateReady) {
      message.error(
        "Befallsgruppen können erst nach erfolgreichem Laden bearbeitet werden.",
      );
      return;
    }
    try {
      await onDelete(groupId);
      message.success("Befallsgruppe gelöscht");
      setDraft(null);
    } catch (error) {
      message.error(
        error instanceof Error
          ? error.message
          : "Befallsgruppe konnte nicht gelöscht werden.",
      );
    }
  };

  return (
    <>
      <section className="pointer-events-auto absolute inset-x-2 bottom-2 z-[58] flex max-h-[72dvh] flex-col overflow-hidden rounded-md bg-white shadow-xl ring-1 ring-slate-900/10 md:bottom-5 md:left-4 md:right-auto md:top-24 md:w-[27rem] md:max-h-[calc(100dvh-8rem)]">
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-3 py-2.5">
          <div>
            <div className="text-sm font-semibold text-slate-950">
              Befallsgruppen
            </div>
            <div className="text-xs text-slate-500">
              Vorschläge nach Nähe und Datum
            </div>
          </div>
          <div className="flex gap-1.5">
            <Button
              size="small"
              icon={<PlusOutlined />}
              disabled={!isGroupStateReady}
              onClick={() =>
                setDraft({
                  name: `Befallsgruppe ${groups.length + 1}`,
                  origin: "manual",
                  treeIds: [],
                  datasetIds: [],
                })
              }
            >
              Neu
            </Button>
            <Button size="small" onClick={onClose}>
              Schließen
            </Button>
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
          {errorMessage && (
            <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
              {errorMessage}
            </div>
          )}

          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Bestätigt ({groups.length})
            </div>
            <div className="space-y-2">
              {groups.map((group) => (
                <div
                  key={group.id}
                  className="rounded-md border border-emerald-200 bg-emerald-50/60 p-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-emerald-950">
                        {group.name}
                      </div>
                      <div className="mt-0.5 text-xs text-emerald-800">
                        {group.treeIds.length} Baum
                        {group.treeIds.length === 1 ? "" : "e"} ·{" "}
                        {group.datasetIds.length} Befliegung
                        {group.datasetIds.length === 1 ? "" : "en"}
                      </div>
                    </div>
                    <Tag color="green" className="m-0">
                      Bestätigt
                    </Tag>
                  </div>
                  <div className="mt-2 flex gap-1.5">
                    <Button
                      size="small"
                      icon={<AimOutlined />}
                      onClick={() => onZoomToTrees(group.treeIds)}
                    >
                      Karte
                    </Button>
                    <Button
                      size="small"
                      icon={<EditOutlined />}
                      disabled={!isGroupStateReady}
                      onClick={() => setDraft(group)}
                    >
                      Bearbeiten
                    </Button>
                  </div>
                </div>
              ))}
              {isGroupStateReady && groups.length === 0 && (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="Noch keine bestätigte Gruppe"
                />
              )}
            </div>
          </div>

          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Vorschläge ({suggestions.length})
            </div>
            <div className="space-y-2">
              {suggestions.map((suggestion, index) => (
                <div
                  key={suggestion.id}
                  className="rounded-md border border-amber-200 bg-amber-50/70 p-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-amber-950">
                        {suggestion.treeIds.length} Bäume
                      </div>
                      <div className="mt-0.5 text-xs text-amber-800">
                        {formatDate(suggestion.minDate)}
                        {suggestion.minDate !== suggestion.maxDate
                          ? `–${formatDate(suggestion.maxDate)}`
                          : ""}{" "}
                        · bis {suggestion.maxNeighborDistanceMeters} m
                      </div>
                    </div>
                    <Tag
                      className="m-0"
                      color={
                        suggestion.confidenceLabel === "hoch"
                          ? "green"
                          : suggestion.confidenceLabel === "mittel"
                            ? "gold"
                            : "orange"
                      }
                    >
                      {suggestion.confidenceLabel}
                    </Tag>
                  </div>
                  <div className="mt-2 flex gap-1.5">
                    <Button
                      size="small"
                      icon={<AimOutlined />}
                      onClick={() => onZoomToTrees(suggestion.treeIds)}
                    >
                      Karte
                    </Button>
                    <Button
                      size="small"
                      type="primary"
                      onClick={() => openSuggestion(suggestion, index)}
                    >
                      Prüfen & speichern
                    </Button>
                  </div>
                </div>
              ))}
              {isLoading && (
                <div className="rounded border border-slate-200 p-3 text-center text-xs text-slate-500">
                  Bestätigte Gruppen werden geladen…
                </div>
              )}
              {!isLoading && errorMessage && (
                <div className="rounded border border-amber-200 bg-amber-50 p-3 text-center text-xs text-amber-800">
                  Vorschläge sind deaktiviert, bis die bestätigten Gruppen
                  geladen werden konnten.
                </div>
              )}
              {isGroupStateReady && suggestions.length === 0 && (
                <div className="rounded border border-slate-200 p-3 text-center text-xs text-slate-500">
                  Keine neuen räumlich-zeitlichen Vorschläge
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      <PriwaBefallsgruppeEditor
        open={draft !== null && isGroupStateReady}
        isMobile={isMobile}
        draft={draft}
        points={points}
        mosaics={mosaics}
        groups={groups}
        isSaving={isSaving}
        onClose={() => setDraft(null)}
        onSave={save}
        onDelete={remove}
      />
    </>
  );
}
