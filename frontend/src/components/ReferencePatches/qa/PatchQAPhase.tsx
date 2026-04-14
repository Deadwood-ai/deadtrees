import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card, Flex, Space, Tag, Typography, message } from "antd";
import { LeftOutlined, RightOutlined } from "@ant-design/icons";
import { IDataset } from "../../../types/dataset";
import { IReferencePatch, PatchResolution } from "../../../types/referencePatches";
import {
  useGenerateNestedPatches,
  useReferencePatches,
  useUpdatePatchStatus,
} from "../../../hooks/useReferencePatches";
import ReferencePatchMap from "../ReferencePatchMap";

interface Props {
  dataset: IDataset;
  onUnsavedChanges: (hasChanges: boolean) => void;
  onRequestValidation: () => void;
}

// Only QA 5cm patches - 10cm patches are auto-validated from their children
const QA_RESOLUTIONS: PatchResolution[] = [5];

export default function PatchQAPhase({ dataset, onUnsavedChanges, onRequestValidation }: Props) {
  const [activeResolution, setActiveResolution] = useState<PatchResolution>(5);
  const { data: patches = [] } = useReferencePatches(dataset.id, activeResolution);
  const { mutate: updateStatus, isPending: updating } = useUpdatePatchStatus();
  const { mutateAsync: generateChildren, isPending: generatingChildren } = useGenerateNestedPatches();

  const sortedPatches = useMemo(
    () => [...patches].sort((a, b) => a.patch_index.localeCompare(b.patch_index)),
    [patches],
  );
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    setCurrentIndex(0);
  }, [activeResolution, sortedPatches.length]);

  const currentPatch = sortedPatches[currentIndex];

  const handleStatusChange = useCallback(
    (status: IReferencePatch["status"]) => {
      if (!currentPatch) return;
      updateStatus({ patchId: currentPatch.id, status });
      onUnsavedChanges(true);
      const nextIdx = Math.min(currentIndex + 1, sortedPatches.length - 1);
      setCurrentIndex(nextIdx);
    },
    [currentPatch, updateStatus, currentIndex, sortedPatches.length, onUnsavedChanges],
  );

  const handleGenerateChildren = async () => {
    if (!currentPatch) return;
    try {
      await generateChildren(currentPatch);
      onUnsavedChanges(true);
      message.success("Generated child patches");
    } catch (error) {
      console.error(error);
      message.error("Failed to generate child patches");
    }
  };

  const handleKeyNav = useCallback(
    (event: KeyboardEvent) => {
      if (!currentPatch) return;
      switch (event.key.toLowerCase()) {
        case "g":
          handleStatusChange("good");
          break;
        case "b":
          handleStatusChange("bad");
          break;
        case "p":
          handleStatusChange("pending");
          break;
        case "arrowright":
          setCurrentIndex((idx) => Math.min(idx + 1, sortedPatches.length - 1));
          break;
        case "arrowleft":
          setCurrentIndex((idx) => Math.max(idx - 1, 0));
          break;
        default:
          break;
      }
    },
    [currentPatch, handleStatusChange, sortedPatches.length],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyNav);
    return () => window.removeEventListener("keydown", handleKeyNav);
  }, [handleKeyNav]);

  const canGenerateChildren = useMemo(() => {
    if (!currentPatch) return false;
    if (currentPatch.resolution_cm === 20) return true;
    return currentPatch.resolution_cm === 10 && currentPatch.status === "good";
  }, [currentPatch]);

  return (
    <div className="flex h-full w-full flex-col p-4">
      <Flex justify="space-between" align="center" className="mb-4">
        <div>
          <Typography.Title level={4} style={{ marginBottom: 0 }}>
            Phase 2: QA Patches
          </Typography.Title>
          <Typography.Text type="secondary">
            Review patches sequentially. Use keyboard shortcuts: G = Good, B = Bad, P = Pending, ←/→ navigation.
          </Typography.Text>
        </div>
        <Space>
          {QA_RESOLUTIONS.map((res) => (
            <Button
              key={res}
              type={res === activeResolution ? "primary" : "default"}
              onClick={() => setActiveResolution(res)}
            >
              {res}cm Patches
            </Button>
          ))}
        </Space>
      </Flex>

      <div className="flex min-h-0 flex-1 gap-4">
        <div className="relative flex-1">
          <ReferencePatchMap
            datasetId={dataset.id}
            cogPath={dataset.cog_path}
            resolution={activeResolution}
            patches={sortedPatches}
            focusPatchId={currentPatch?.id}
            layerSelection="deadwood"
            selectedPatchId={currentPatch?.id}
            selectedBasePatch={currentPatch}
          />
          {/* Note: LayerRadioButtons not shown in QA view, using default "deadwood" */}
        </div>

        <div className="w-96 flex-shrink-0 space-y-4">
          <Card title="Current Patch" size="small">
            {currentPatch ? (
              <Space direction="vertical" size="middle">
                <Space>
                  <Tag color="blue">{currentPatch.resolution_cm} cm</Tag>
                  <Tag
                    color={currentPatch.status === "good" ? "green" : currentPatch.status === "bad" ? "red" : "default"}
                  >
                    {currentPatch.status.toUpperCase()}
                  </Tag>
                </Space>
                <Typography.Text className="font-mono">{currentPatch.patch_index}</Typography.Text>
                <Typography.Text type="secondary">
                  AOI overlap: {currentPatch.aoi_coverage_percent ?? "n/a"}%
                </Typography.Text>
                <Space>
                  <Button icon={<LeftOutlined />} onClick={() => setCurrentIndex((i) => Math.max(i - 1, 0))}>
                    Previous
                  </Button>
                  <Button
                    icon={<RightOutlined />}
                    onClick={() => setCurrentIndex((i) => Math.min(i + 1, sortedPatches.length - 1))}
                  >
                    Next
                  </Button>
                </Space>
                <Space>
                  <Button type="primary" onClick={() => handleStatusChange("good")} loading={updating}>
                    Mark Good (G)
                  </Button>
                  <Button danger onClick={() => handleStatusChange("bad")} loading={updating}>
                    Mark Bad (B)
                  </Button>
                </Space>
                <Button onClick={() => handleStatusChange("pending")} loading={updating}>
                  Reset to Pending (P)
                </Button>
                <Button onClick={handleGenerateChildren} disabled={!canGenerateChildren} loading={generatingChildren}>
                  Generate Nested Patches
                </Button>
              </Space>
            ) : (
              <Typography.Text type="secondary">No patches at this resolution.</Typography.Text>
            )}
          </Card>

          <Card title="Summary" size="small">
            <Typography.Paragraph>
              Reviewing {sortedPatches.length} {activeResolution}cm patches.
            </Typography.Paragraph>
            <Button type="primary" onClick={onRequestValidation} disabled={sortedPatches.length === 0}>
              Proceed to Validation
            </Button>
          </Card>
        </div>
      </div>
    </div>
  );
}
