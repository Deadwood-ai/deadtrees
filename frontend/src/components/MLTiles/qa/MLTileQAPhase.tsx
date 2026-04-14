import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card, Flex, Space, Tag, Typography, message } from "antd";
import { LeftOutlined, RightOutlined } from "@ant-design/icons";
import { IDataset } from "../../../types/dataset";
import { IMLTile, TileResolution } from "../../../types/mlTiles";
import { useGenerateNestedTiles, useMLTiles, useUpdateTileStatus } from "../../../hooks/useMLTiles";
import MLTileMap from "../MLTileMap";

interface Props {
  dataset: IDataset;
  onUnsavedChanges: (hasChanges: boolean) => void;
  onRequestValidation: () => void;
}

const QA_RESOLUTIONS: TileResolution[] = [20, 10];

export default function MLTileQAPhase({ dataset, onUnsavedChanges, onRequestValidation }: Props) {
  const [activeResolution, setActiveResolution] = useState<TileResolution>(20);
  const { data: tiles = [] } = useMLTiles(dataset.id, activeResolution);
  const { mutate: updateStatus, isPending: updating } = useUpdateTileStatus();
  const { mutateAsync: generateChildren, isPending: generatingChildren } = useGenerateNestedTiles();

  const sortedTiles = useMemo(() => [...tiles].sort((a, b) => a.tile_index.localeCompare(b.tile_index)), [tiles]);
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    setCurrentIndex(0);
  }, [activeResolution, sortedTiles.length]);

  const currentTile = sortedTiles[currentIndex];

  const handleStatusChange = useCallback(
    (status: IMLTile["status"]) => {
      if (!currentTile) return;
      updateStatus({ tileId: currentTile.id, status });
      onUnsavedChanges(true);
      const nextIdx = Math.min(currentIndex + 1, sortedTiles.length - 1);
      setCurrentIndex(nextIdx);
    },
    [currentTile, updateStatus, currentIndex, sortedTiles.length, onUnsavedChanges],
  );

  const handleGenerateChildren = async () => {
    if (!currentTile) return;
    try {
      await generateChildren(currentTile);
      onUnsavedChanges(true);
      message.success("Generated child tiles");
    } catch (error) {
      console.error(error);
      message.error("Failed to generate child tiles");
    }
  };

  const handleKeyNav = useCallback(
    (event: KeyboardEvent) => {
      if (!currentTile) return;
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
          setCurrentIndex((idx) => Math.min(idx + 1, sortedTiles.length - 1));
          break;
        case "arrowleft":
          setCurrentIndex((idx) => Math.max(idx - 1, 0));
          break;
        default:
          break;
      }
    },
    [currentTile, handleStatusChange, sortedTiles.length],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyNav);
    return () => window.removeEventListener("keydown", handleKeyNav);
  }, [handleKeyNav]);

  const canGenerateChildren = useMemo(() => {
    if (!currentTile) return false;
    if (currentTile.resolution_cm === 20) return true;
    return currentTile.resolution_cm === 10 && currentTile.status === "good";
  }, [currentTile]);

  return (
    <div className="flex h-full w-full flex-col p-4">
      <Flex justify="space-between" align="center" className="mb-4">
        <div>
          <Typography.Title level={4} style={{ marginBottom: 0 }}>
            Phase 2: QA Tiles
          </Typography.Title>
          <Typography.Text type="secondary">
            Review tiles sequentially. Use keyboard shortcuts: G = Good, B = Bad, P = Pending, ←/→ navigation.
          </Typography.Text>
        </div>
        <Space>
          {QA_RESOLUTIONS.map((res) => (
            <Button
              key={res}
              type={res === activeResolution ? "primary" : "default"}
              onClick={() => setActiveResolution(res)}
            >
              {res}cm Tiles
            </Button>
          ))}
        </Space>
      </Flex>

      <div className="flex min-h-0 flex-1 gap-4">
        <div className="flex-1">
          <MLTileMap
            datasetId={dataset.id}
            cogPath={dataset.cog_path}
            resolution={activeResolution}
            tiles={sortedTiles}
            focusTileId={currentTile?.id}
          />
        </div>

        <div className="w-96 flex-shrink-0 space-y-4">
          <Card title="Current Tile" size="small">
            {currentTile ? (
              <Space direction="vertical" size="middle">
                <Space>
                  <Tag color="blue">{currentTile.resolution_cm} cm</Tag>
                  <Tag
                    color={currentTile.status === "good" ? "green" : currentTile.status === "bad" ? "red" : "default"}
                  >
                    {currentTile.status.toUpperCase()}
                  </Tag>
                </Space>
                <Typography.Text className="font-mono">{currentTile.tile_index}</Typography.Text>
                <Typography.Text type="secondary">
                  AOI overlap: {currentTile.aoi_coverage_percent ?? "n/a"}%
                </Typography.Text>
                <Space>
                  <Button icon={<LeftOutlined />} onClick={() => setCurrentIndex((i) => Math.max(i - 1, 0))}>
                    Previous
                  </Button>
                  <Button
                    icon={<RightOutlined />}
                    onClick={() => setCurrentIndex((i) => Math.min(i + 1, sortedTiles.length - 1))}
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
                  Generate Nested Tiles
                </Button>
              </Space>
            ) : (
              <Typography.Text type="secondary">No tiles at this resolution.</Typography.Text>
            )}
          </Card>

          <Card title="Summary" size="small">
            <Typography.Paragraph>
              Reviewing {sortedTiles.length} {activeResolution}cm tiles.
            </Typography.Paragraph>
            <Button type="primary" onClick={onRequestValidation} disabled={sortedTiles.length === 0}>
              Proceed to Validation
            </Button>
          </Card>
        </div>
      </div>
    </div>
  );
}
