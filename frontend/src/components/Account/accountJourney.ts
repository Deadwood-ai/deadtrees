import type { ContributorDataset } from "../DatasetStatus/status";
import { isDatasetProcessingComplete } from "../../utils/processingSteps";

export interface JourneyDataset extends ContributorDataset {
  freidata_doi?: string | null;
  citation_doi?: string | null;
}

export interface JourneyStep {
  key: "upload" | "process" | "publish";
  title: string;
  value: number;
  label: string;
  /** Share of uploaded datasets that reached this step (0-1), drawn as a thin bar. */
  progress?: number;
  details: { label: string; value: number }[];
}

// A review lock does not undo completed processing, matching the dataset table.
function hasResults(dataset: JourneyDataset) {
  return isDatasetProcessingComplete({
    ...dataset,
    current_status: dataset.current_status === "audit_in_progress" ? "idle" : dataset.current_status,
  });
}

/** The contributor's datasets as the DeadTrees journey: upload, process, publish. */
export function computeAccountJourney(datasets: JourneyDataset[], inPublicationIds: number[]): JourneyStep[] {
  const total = datasets.length;
  const ready = datasets.filter(hasResults);
  const processing = datasets.filter(
    (d) => !d.has_error && !!d.current_status && !["idle", "audit_in_progress"].includes(d.current_status),
  );
  const stopped = datasets.filter((d) => d.has_error);
  const withDoi = datasets.filter((d) => d.freidata_doi || d.citation_doi);
  const inReview = new Set(inPublicationIds);
  const reviewing = datasets.filter((d) => !d.freidata_doi && !d.citation_doi && inReview.has(d.id));
  const awaitingDoi = ready.filter((d) => !d.freidata_doi && !d.citation_doi && !inReview.has(d.id));
  const share = (count: number) => (total ? count / total : 0);

  return [
    {
      key: "upload",
      title: "Upload",
      value: total,
      label: total === 1 ? "dataset uploaded" : "datasets uploaded",
      details: [
        { label: "Public", value: datasets.filter((d) => d.data_access === "public").length },
        { label: "Private or view only", value: datasets.filter((d) => d.data_access !== "public").length },
      ],
    },
    {
      key: "process",
      title: "Process",
      value: ready.length,
      label: "with results ready",
      progress: share(ready.length),
      details: [
        { label: "Processing now", value: processing.length },
        { label: "Stopped", value: stopped.length },
      ],
    },
    {
      key: "publish",
      title: "Publish",
      value: withDoi.length,
      label: withDoi.length === 1 ? "dataset with a DOI" : "datasets with a DOI",
      progress: share(withDoi.length),
      details: [
        { label: "In review", value: reviewing.length },
        { label: "Results ready, no DOI yet", value: awaitingDoi.length },
      ],
    },
  ];
}
