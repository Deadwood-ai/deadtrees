import { Alert, Button, Drawer, Tag } from "antd";
import { useIsMobile } from "../../hooks/useIsMobile";
import QualityFindings from "./QualityFindings";
import {
  canOpenOwnerMap,
  processingStatus,
  statusSummary,
  type ContributorDataset,
  type QueueState,
} from "./status";

interface StatusDrawerProps {
  dataset: ContributorDataset;
  queue: QueueState;
  /**
   * Called as soon as the user asks to close. The caller unmounts the drawer
   * and restores focus. Waiting for the close animation is deliberately avoided:
   * an Escape during the opening motion would otherwise never complete the close.
   */
  onClose: () => void;
  onViewMap: (id: number) => void;
}

export default function StatusDrawer({ dataset, queue, onClose, onViewMap }: StatusDrawerProps) {
  const mobile = useIsMobile();
  const processing = processingStatus(dataset, queue);
  const summary = statusSummary(dataset, queue);
  const mapAvailable = canOpenOwnerMap(dataset);

  return (
    <Drawer open title="Dataset status" width={mobile ? "100%" : 460} onClose={onClose} destroyOnHidden>
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Dataset {dataset.id}</p>
      <h2 className="mb-4 break-words text-lg font-semibold text-slate-900">{dataset.file_name}</h2>

      {dataset.archived && (
        <Alert
          className="mb-4"
          type="info"
          message="Archived dataset"
          description="This dataset is hidden from your active list. Its status remains available here."
        />
      )}

      <section className="mb-6 rounded-lg bg-slate-50 p-4" aria-label="Summary">
        <Tag color={processing.color} className="dt-status-tag mb-2">
          {processing.label}
        </Tag>
        <p className="m-0 text-sm text-slate-800">{summary.headline}</p>
        {summary.next && <p className="mb-0 mt-2 text-sm text-slate-600">{summary.next}</p>}
        {mapAvailable && (
          <Button className="mt-3" onClick={() => onViewMap(dataset.id)}>
            View map
          </Button>
        )}
      </section>

      {/* The checks need the map image; without one there is nothing to show. */}
      {mapAvailable && <QualityFindings dataset={dataset} />}

      <p className="mb-0 mt-7 border-t border-slate-100 pt-4 text-sm text-slate-500">
        Need help?{" "}
        <a href={`mailto:info@deadtrees.earth?subject=Dataset%20${dataset.id}`}>Contact the DeadTrees team</a> and
        include dataset {dataset.id}.
      </p>
    </Drawer>
  );
}
