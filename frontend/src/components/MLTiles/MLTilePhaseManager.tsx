import { useState } from "react";
import { Tabs, Button, Space, Statistic, Progress, message } from "antd";
import { IDataset } from "../../types/dataset";
import { useMLTiles, useTileProgress, useCompleteTileGeneration } from "../../hooks/useMLTiles";
import MLTilePlacementPhase from "./placement/MLTilePlacementPhase";
import MLTileQAPhase from "./qa/MLTileQAPhase";
import MLTileValidationPhase from "./validation/MLTileValidationPhase";

interface Props {
  dataset: IDataset;
  onUnsavedChanges: (hasChanges: boolean) => void;
}

export default function MLTilePhaseManager({ dataset, onUnsavedChanges }: Props) {
  const [activePhase, setActivePhase] = useState<"placement" | "qa" | "validation">("placement");
  const { data: tiles20cm } = useMLTiles(dataset.id, 20);
  const { data: progress } = useTileProgress(dataset.id);
  const { mutateAsync: completeGeneration, isPending: isCompleting } = useCompleteTileGeneration();

  const has20cmTiles = (tiles20cm?.length || 0) > 0;
  const totalTiles = (progress?.total_10cm || 0) + (progress?.total_5cm || 0);
  const completedTiles =
    (progress?.good_10cm || 0) + (progress?.bad_10cm || 0) + (progress?.good_5cm || 0) + (progress?.bad_5cm || 0);
  const completionPercent = totalTiles > 0 ? Math.round((completedTiles / totalTiles) * 100) : 0;

  const canMoveToValidation = completionPercent > 0;

  const handleComplete = async () => {
    try {
      await completeGeneration(dataset.id);
      message.success("Dataset marked as Training Ready");
    } catch (err) {
      message.error("Failed to complete tile generation");
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="border-b bg-gray-50 p-4">
        <Space size="large">
          <Statistic title="20cm Base Tiles" value={progress?.total_20cm || 0} />
          <Statistic
            title="10cm Tiles (Good)"
            value={progress?.good_10cm || 0}
            suffix={`/ ${progress?.total_10cm || 0}`}
          />
          <Statistic
            title="5cm Tiles (Good)"
            value={progress?.good_5cm || 0}
            suffix={`/ ${progress?.total_5cm || 0}`}
          />
          <div>
            <div className="mb-1 text-sm text-gray-500">Overall Progress</div>
            <Progress percent={completionPercent} style={{ width: 200 }} />
          </div>
          {completionPercent === 100 && (
            <Button type="primary" size="large" onClick={handleComplete} loading={isCompleting}>
              Mark as Training Ready
            </Button>
          )}
        </Space>
      </div>

      <Tabs
        activeKey={activePhase}
        onChange={(key) => setActivePhase(key as any)}
        className="flex-1"
        items={[
          {
            key: "placement",
            label: "Phase 1: Place 20cm Tiles",
            children: (
              <MLTilePlacementPhase
                dataset={dataset}
                onUnsavedChanges={onUnsavedChanges}
                onNavigateToQA={() => setActivePhase("qa")}
              />
            ),
          },
          {
            key: "qa",
            label: "Phase 2: QA Tiles",
            disabled: !has20cmTiles,
            children: (
              <MLTileQAPhase
                dataset={dataset}
                onUnsavedChanges={onUnsavedChanges}
                onRequestValidation={() => setActivePhase("validation")}
              />
            ),
          },
          {
            key: "validation",
            label: "Phase 3: Validate & Review",
            disabled: !canMoveToValidation,
            children: <MLTileValidationPhase dataset={dataset} />,
          },
        ]}
      />
    </div>
  );
}
