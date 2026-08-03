import { suggestPriwaBefallsgruppen } from "./priwaBefallsgruppeSuggestions";
import type {
  IPriwaBefallsgruppe,
  IPriwaBefallsgruppeSaveInput,
  IPriwaPoint,
} from "./types";
import type { IPriwaMosaic } from "./usePriwaMosaics";
import { buildPriwaMosaicMatchIndex } from "./usePriwaMosaicMatches";

export type PriwaReviewStatus =
  | "group_suggestion"
  | "flight_missing"
  | "flight_suggested"
  | "needs_review"
  | "complete"
  | "unassigned_upload"
  | "excluded_upload";

export interface IPriwaGroupReviewItem {
  key: string;
  kind: "saved-group" | "suggested-group";
  name: string;
  status: Exclude<PriwaReviewStatus, "unassigned_upload" | "excluded_upload">;
  group: IPriwaBefallsgruppe | null;
  draft: IPriwaBefallsgruppeSaveInput;
  treeIds: string[];
  assignedDatasetIds: string[];
  suggestedDatasetIds: string[];
  suggestionReason: string | null;
  confidenceLabel: "hoch" | "mittel" | "niedrig" | null;
}

export interface IPriwaUploadReviewItem {
  key: string;
  kind: "unassigned-upload";
  status: "unassigned_upload" | "excluded_upload";
  mosaic: IPriwaMosaic;
  reason: string;
}

export type IPriwaReviewItem = IPriwaGroupReviewItem | IPriwaUploadReviewItem;

const formatDate = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
};

const unique = (values: string[]) => Array.from(new Set(values));

const confidenceLabel = (confidence: number) => {
  if (confidence >= 0.75) return "hoch" as const;
  if (confidence >= 0.45) return "mittel" as const;
  return "niedrig" as const;
};

const groupStatus = (
  group: IPriwaBefallsgruppe,
  mosaicsById: Map<string, IPriwaMosaic>,
  suggestedDatasetIds: string[],
): IPriwaGroupReviewItem["status"] => {
  if (group.datasetIds.length === 0) {
    return suggestedDatasetIds.length > 0
      ? "flight_suggested"
      : "flight_missing";
  }

  const allAssignedFlightsConfirmed = group.datasetIds.every(
    (datasetId) =>
      mosaicsById.get(datasetId)?.flightType === "umfeldbefliegung",
  );
  if (!allAssignedFlightsConfirmed) return "needs_review";
  return suggestedDatasetIds.length > 0 ? "flight_suggested" : "complete";
};

export const buildPriwaReviewWorkspace = (
  points: IPriwaPoint[],
  mosaics: IPriwaMosaic[],
  groups: IPriwaBefallsgruppe[],
): IPriwaReviewItem[] => {
  const mosaicsById = new Map(mosaics.map((mosaic) => [mosaic.id, mosaic]));
  const rawMatches = buildPriwaMosaicMatchIndex(points, mosaics);
  const candidateDatasetIdsForTrees = (treeIds: string[]) =>
    unique(
      treeIds.flatMap((treeId) => {
        const datasetId = rawMatches.mosaicIdByPointId[treeId];
        return datasetId ? [datasetId] : [];
      }),
    );

  const savedItems: IPriwaGroupReviewItem[] = groups.map((group) => {
    const suggestedDatasetIds = candidateDatasetIdsForTrees(
      group.treeIds,
    ).filter((datasetId) => !group.datasetIds.includes(datasetId));

    return {
      key: `group:${group.id}`,
      kind: "saved-group",
      name: group.name,
      status: groupStatus(group, mosaicsById, suggestedDatasetIds),
      group,
      draft: {
        id: group.id,
        name: group.name,
        origin: group.origin,
        confidence: group.confidence,
        suggestionReason: group.suggestionReason,
        algorithmVersion: group.algorithmVersion,
        treeIds: group.treeIds,
        datasetIds: group.datasetIds,
      },
      treeIds: group.treeIds,
      assignedDatasetIds: group.datasetIds,
      suggestedDatasetIds,
      suggestionReason: group.suggestionReason,
      confidenceLabel:
        group.confidence === null ? null : confidenceLabel(group.confidence),
    };
  });

  const confirmedTreeIds = new Set(groups.flatMap((group) => group.treeIds));
  const suggestedItems: IPriwaGroupReviewItem[] = suggestPriwaBefallsgruppen(
    points,
    confirmedTreeIds,
  ).map((suggestion, index) => {
    const name = `Befallsgruppe ${formatDate(suggestion.maxDate)}-${index + 1}`;
    const suggestedDatasetIds = candidateDatasetIdsForTrees(suggestion.treeIds);
    return {
      key: `suggestion:${suggestion.id}`,
      kind: "suggested-group",
      name,
      status: "group_suggestion",
      group: null,
      draft: {
        name,
        origin: "suggestion",
        confidence: suggestion.confidence,
        suggestionReason: suggestion.reason,
        algorithmVersion: suggestion.algorithmVersion,
        treeIds: suggestion.treeIds,
        datasetIds: suggestedDatasetIds,
      },
      treeIds: suggestion.treeIds,
      assignedDatasetIds: [],
      suggestedDatasetIds,
      suggestionReason: suggestion.reason,
      confidenceLabel: suggestion.confidenceLabel,
    };
  });

  const claimedDatasetIds = new Set(
    [...savedItems, ...suggestedItems].flatMap((item) => [
      ...item.assignedDatasetIds,
      ...item.suggestedDatasetIds,
    ]),
  );
  const unmatchedReasonsByMosaicId = new Map(
    rawMatches.unmatchedMosaics.map(({ mosaic, reason }) => [
      mosaic.id,
      reason,
    ]),
  );
  const candidateMosaics = [
    ...rawMatches.matchedMosaics.map(({ mosaic }) => mosaic),
    ...rawMatches.unmatchedMosaics.map(({ mosaic }) => mosaic),
  ];
  const uploadItems: IPriwaUploadReviewItem[] = candidateMosaics
    .filter((mosaic) => !claimedDatasetIds.has(mosaic.id))
    .map((mosaic) => ({
      key: `upload:${mosaic.id}`,
      kind: "unassigned-upload",
      status: "unassigned_upload",
      mosaic,
      reason:
        unmatchedReasonsByMosaicId.get(mosaic.id) ??
        "Die Befliegung passt zu einzelnen Käferbäumen, aber noch zu keiner Befallsgruppe.",
    }));
  const excludedUploadItems: IPriwaUploadReviewItem[] =
    rawMatches.excludedMosaics.map((mosaic) => ({
      key: `upload:${mosaic.id}`,
      kind: "unassigned-upload",
      status: "excluded_upload",
      mosaic,
      reason: "Als nicht PRIWA-relevant ausgeschlossen.",
    }));

  const rank: Record<PriwaReviewStatus, number> = {
    group_suggestion: 0,
    flight_suggested: 1,
    needs_review: 2,
    flight_missing: 3,
    unassigned_upload: 4,
    complete: 5,
    excluded_upload: 6,
  };

  return [
    ...savedItems,
    ...suggestedItems,
    ...uploadItems,
    ...excludedUploadItems,
  ].sort((left, right) => rank[left.status] - rank[right.status]);
};

export const isOpenPriwaReviewItem = (item: IPriwaReviewItem) =>
  item.status !== "complete" && item.status !== "excluded_upload";

export const reviewItemDatasetIds = (item: IPriwaReviewItem) =>
  item.kind === "unassigned-upload"
    ? [item.mosaic.id]
    : [...new Set([...item.assignedDatasetIds, ...item.suggestedDatasetIds])];
