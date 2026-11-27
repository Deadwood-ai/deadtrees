import { Typography } from "antd";
import { useDatasetAuditSummary } from "../../hooks/useDatasetAuditSummary";
import { reasonWord } from "../../utils/auditChecks";
import { InfoRow, Pending } from "../DatasetQuality/InfoRow";
import AcquisitionDateRows from "../DatasetQuality/AcquisitionDateRows";
import PhenologyRow from "../DatasetQuality/PhenologyRow";
import { AoiRow, GeorefRow, PredictionQuality } from "../DatasetQuality/AuditFindings";
import { imageCheck, type ContributorDataset, type ImageCheck } from "./status";

const IMAGE_WORDS: Record<ImageCheck["kind"], string | null> = {
  pending: null,
  accepted: "Accepted",
  excluded: "Excluded from public map",
};

/** The automated image quality check, pending until it decided; an exclusion says why. */
function ImageQualityRow({ dataset }: { dataset: ContributorDataset }) {
  const check = imageCheck(dataset);
  const { data: summary } = useDatasetAuditSummary(dataset.id);
  const reason = check?.kind === "excluded" ? reasonWord(summary?.evaluation_reason) : undefined;
  const word = check && IMAGE_WORDS[check.kind];
  return (
    <InfoRow
      label="Image quality"
      tooltip="An automated check of the whole orthophoto: sharp, true colour, shows trees, no large artifacts or holes. Images that fail stay in your account but are left off the public map."
    >
      <Typography.Text style={word ? { color: check.color } : undefined} data-testid="dataset-image-quality">
        {word ? (reason ? `${word}: ${reason}` : word) : <Pending />}
      </Typography.Text>
    </InfoRow>
  );
}

/** What the automatic checks found on the owner's dataset: the dataset page's findings, plus
 * the image check, which only the owner sees. */
export default function QualityFindings({ dataset }: { dataset: ContributorDataset }) {
  return (
    <>
      <section className="mb-6 space-y-3" aria-label="Data quality">
        <h3 className="mb-1 text-sm font-semibold">Data quality</h3>
        <p className="mb-2 text-xs text-slate-500">Results of the automatic checks on your upload.</p>
        <ImageQualityRow dataset={dataset} />
        <GeorefRow datasetId={dataset.id} />
        <AoiRow datasetId={dataset.id} />
        <AcquisitionDateRows dataset={dataset} />
        <PhenologyRow dataset={dataset} />
      </section>
      <section className="border-t border-slate-100 pt-5" aria-label="Prediction quality">
        <PredictionQuality datasetId={dataset.id} />
      </section>
    </>
  );
}
