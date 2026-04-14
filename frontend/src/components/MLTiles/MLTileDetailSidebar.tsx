import { useMemo, useEffect, useCallback, useState, useRef } from "react";
import { Button, Card, Progress, Radio, Space, Typography, Alert, Tabs } from "antd";
import {
  LeftOutlined,
  RightOutlined,
  DeleteOutlined,
  CheckCircleOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { IMLTile, TileResolution, TileStatus } from "../../types/mlTiles";

interface Props {
  baseTile: IMLTile;
  selectedTile: IMLTile;
  selectedResolution: TileResolution;
  allTiles: IMLTile[];
  onResolutionChange: (resolution: TileResolution) => void;
  onTileSelect: (tileId: number | null) => void;
  onStatusUpdate: (tileId: number, status: TileStatus) => Promise<void>;
  onDelete: (tileId: number) => Promise<void>;
  onGenerateSubTiles?: (baseTile: IMLTile) => Promise<void>;
}

export default function MLTileDetailSidebar({
  baseTile,
  selectedTile,
  selectedResolution,
  allTiles,
  onResolutionChange,
  onTileSelect,
  onStatusUpdate,
  onDelete,
  onGenerateSubTiles,
}: Props) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [optimisticStatuses, setOptimisticStatuses] = useState<Map<number, TileStatus>>(new Map());
  const [isDelayingNavigation, setIsDelayingNavigation] = useState(false);

  // Ref to always access the latest optimistic statuses (fixes stale closure in setTimeout)
  const optimisticStatusesRef = useRef(optimisticStatuses);
  useEffect(() => {
    optimisticStatusesRef.current = optimisticStatuses;
  }, [optimisticStatuses]);

  // Get all tiles for the selected base tile
  const baseTileFamily = useMemo(() => {
    const baseIndex = baseTile.tile_index;
    return allTiles.filter((t) => t.tile_index === baseIndex || t.tile_index.startsWith(baseIndex + "_"));
  }, [allTiles, baseTile.tile_index]);

  // Check if sub-tiles have been generated
  const hasSubTiles = baseTileFamily.length > 1;

  // Get tiles for current resolution
  const tilesForResolution = useMemo(
    () => baseTileFamily.filter((t) => t.resolution_cm === selectedResolution),
    [baseTileFamily, selectedResolution],
  );

  // Sort tiles spatially: top to bottom (ascending Y), then left to right (ascending X)
  const sortedTiles = useMemo(() => {
    return [...tilesForResolution].sort((a, b) => {
      // Get center coordinates
      const aCoords = a.geometry.coordinates[0];
      const aCenterY = (aCoords[0][1] + aCoords[2][1]) / 2;
      const aCenterX = (aCoords[0][0] + aCoords[2][0]) / 2;

      const bCoords = b.geometry.coordinates[0];
      const bCenterY = (bCoords[0][1] + bCoords[2][1]) / 2;
      const bCenterX = (bCoords[0][0] + bCoords[2][0]) / 2;

      // Sort by Y (ascending - southernmost first, which is top-left on screen)
      const yDiff = aCenterY - bCenterY;
      if (Math.abs(yDiff) > 1) return yDiff > 0 ? -1 : 1;

      // Then by X (ascending - westernmost first)
      return aCenterX - bCenterX;
    });
  }, [tilesForResolution]);

  // Current tile index in sorted list
  const currentIndex = sortedTiles.findIndex((t) => t.id === selectedTile.id);

  // Auto-select first tile if none is selected (e.g., after generating sub-tiles)
  // BUT don't auto-select if all tiles are already completed
  useEffect(() => {
    if (currentIndex === -1 && sortedTiles.length > 0) {
      // Check if there are any pending tiles (considering optimistic statuses)
      const hasPendingTiles = sortedTiles.some((t) => {
        const optimisticStatus = optimisticStatusesRef.current.get(t.id);
        const effectiveStatus = optimisticStatus || t.status || "pending";
        return effectiveStatus === "pending";
      });

      // Only auto-select if there are pending tiles
      // This prevents re-selecting when user has completed all tiles
      if (hasPendingTiles) {
        onTileSelect(sortedTiles[0].id);
      }
    }
  }, [currentIndex, sortedTiles, onTileSelect]);

  // Calculate progress for this base tile
  const baseTileProgress = useMemo(() => {
    const tiles10 = baseTileFamily.filter((t) => t.resolution_cm === 10);
    const tiles5 = baseTileFamily.filter((t) => t.resolution_cm === 5);
    const completed10 = tiles10.filter((t) => t.status === "good" || t.status === "bad").length;
    const completed5 = tiles5.filter((t) => t.status === "good" || t.status === "bad").length;
    const total = tiles10.length + tiles5.length;
    const completed = completed10 + completed5;
    return {
      completed10,
      total10: tiles10.length,
      completed5,
      total5: tiles5.length,
      percent: total > 0 ? Math.round((completed / total) * 100) : 0,
    };
  }, [baseTileFamily]);

  // Find next pending tile
  const findNextPendingTile = useCallback(() => {
    // Helper to get effective status (optimistic or actual)
    // Use ref to always get the latest optimistic statuses
    const getEffectiveStatus = (tile: IMLTile) => {
      return optimisticStatusesRef.current.get(tile.id) || tile.status || "pending";
    };

    // First priority: look for pending tiles in current resolution after current index
    const nextInResolution = sortedTiles.find((t, idx) => idx > currentIndex && getEffectiveStatus(t) === "pending");
    if (nextInResolution) return nextInResolution;

    // Second priority: wrap around within current resolution to complete all tiles
    // Look for ANY pending tiles from the beginning (before current index)
    const wrapAroundInCurrentRes = sortedTiles.find((t) => getEffectiveStatus(t) === "pending");
    if (wrapAroundInCurrentRes) return wrapAroundInCurrentRes;

    // Third priority: current resolution is 100% complete, move to next resolution
    const resolutions: TileResolution[] = [20, 10, 5];
    const currentResIdx = resolutions.indexOf(selectedResolution);
    for (let i = currentResIdx + 1; i < resolutions.length; i++) {
      const nextRes = resolutions[i];
      const tilesInNextRes = baseTileFamily.filter((t) => t.resolution_cm === nextRes);

      // Sort spatially like sortedTiles
      const sortedNextRes = tilesInNextRes.sort((a, b) => {
        const aCoords = a.geometry.coordinates[0];
        const aCenterY = (aCoords[0][1] + aCoords[2][1]) / 2;
        const aCenterX = (aCoords[0][0] + aCoords[2][0]) / 2;

        const bCoords = b.geometry.coordinates[0];
        const bCenterY = (bCoords[0][1] + bCoords[2][1]) / 2;
        const bCenterX = (bCoords[0][0] + bCoords[2][0]) / 2;

        const yDiff = aCenterY - bCenterY;
        if (Math.abs(yDiff) > 1) return yDiff > 0 ? -1 : 1;
        return aCenterX - bCenterX;
      });

      const pendingInNextRes = sortedNextRes.find((t) => getEffectiveStatus(t) === "pending");
      if (pendingInNextRes) {
        onResolutionChange(nextRes);
        return pendingInNextRes;
      }
    }

    // No pending tiles found in any resolution - all complete!
    return null;
  }, [sortedTiles, currentIndex, selectedResolution, baseTileFamily, onResolutionChange]);

  // Handle navigation
  const handlePrevious = useCallback(() => {
    if (currentIndex > 0) {
      onTileSelect(sortedTiles[currentIndex - 1].id);
    }
  }, [currentIndex, sortedTiles, onTileSelect]);

  const handleNext = useCallback(() => {
    if (currentIndex < sortedTiles.length - 1) {
      onTileSelect(sortedTiles[currentIndex + 1].id);
    }
  }, [currentIndex, sortedTiles, onTileSelect]);

  const handleJumpToNextPending = () => {
    const next = findNextPendingTile();
    if (next) {
      onTileSelect(next.id);
    }
  };

  // Handle generating sub-tiles
  const handleGenerateSubTiles = useCallback(async () => {
    if (!onGenerateSubTiles) return;
    setIsGenerating(true);
    try {
      await onGenerateSubTiles(baseTile);
    } finally {
      setIsGenerating(false);
    }
  }, [baseTile, onGenerateSubTiles]);

  // Clear optimistic status for the current tile when navigating to a different tile
  // This ensures we always show fresh data when selecting a tile
  useEffect(() => {
    // When tile changes, clear any stale optimistic status for the previous tile
    // Keep optimistic statuses only during the brief delay period
    return () => {
      // Cleanup when tile changes
    };
  }, [selectedTile.id]);

  // Get the current display status (optimistic if available, otherwise actual)
  // Use useMemo to ensure it recalculates when dependencies change
  const displayStatus = useMemo(() => {
    const optimistic = optimisticStatuses.get(selectedTile.id);
    const actual = selectedTile.status || "pending";
    return optimistic || actual;
  }, [optimisticStatuses, selectedTile.id, selectedTile.status]);

  // Handle status change from radio button (instant with auto-advance after brief delay)
  const handleRadioStatusChange = useCallback(
    async (status: TileStatus) => {
      const tileIdToUpdate = selectedTile.id;

      // Set optimistic status immediately for instant UI feedback
      const updatedStatuses = new Map(optimisticStatuses);
      updatedStatuses.set(tileIdToUpdate, status);
      setOptimisticStatuses(updatedStatuses);

      // CRITICAL: Update the ref synchronously so findNextPendingTile sees the change
      optimisticStatusesRef.current = updatedStatuses;

      // Mark that we're delaying navigation to hide the clear button
      setIsDelayingNavigation(true);

      // Wait briefly to show visual feedback, then advance and update
      setTimeout(() => {
        // Auto-advance to next pending tile
        const next = findNextPendingTile();
        if (next) {
          onTileSelect(next.id);
        } else {
          // No more pending tiles - all complete! Just deselect immediately
          onTileSelect(null);
        }

        // Clear the delaying flag after navigation
        setIsDelayingNavigation(false);

        // Update status in background after navigating
        onStatusUpdate(tileIdToUpdate, status).then(() => {
          // Clear optimistic status after DB update completes
          setOptimisticStatuses((prev) => {
            const next = new Map(prev);
            next.delete(tileIdToUpdate);
            return next;
          });
          // Also clear from ref
          optimisticStatusesRef.current.delete(tileIdToUpdate);
        });
      }, 200); // 200ms delay to show button state change
    },
    [selectedTile, findNextPendingTile, onStatusUpdate, onTileSelect, optimisticStatuses],
  );

  // Handle clear rating (no auto-advance)
  const handleClearRating = useCallback(async () => {
    const tileIdToUpdate = selectedTile.id;

    // Set optimistic status to pending immediately
    const updatedStatuses = new Map(optimisticStatuses);
    updatedStatuses.set(tileIdToUpdate, "pending");
    setOptimisticStatuses(updatedStatuses);

    // Update ref synchronously
    optimisticStatusesRef.current = updatedStatuses;

    // Mark that we're in a transition state
    setIsDelayingNavigation(true);

    // Update status immediately in background
    onStatusUpdate(tileIdToUpdate, "pending").then(() => {
      // Wait a bit after DB update before clearing optimistic status
      // This ensures the refetch has completed and we have the new data
      setTimeout(() => {
        setIsDelayingNavigation(false);
        setOptimisticStatuses((prev) => {
          const next = new Map(prev);
          next.delete(tileIdToUpdate);
          return next;
        });
        // Also clear from ref
        optimisticStatusesRef.current.delete(tileIdToUpdate);
      }, 100);
    });
  }, [selectedTile, onStatusUpdate, optimisticStatuses]);

  // Handle status change with auto-advance (for keyboard shortcuts)
  const handleStatusChangeWithAdvance = useCallback(
    async (status: TileStatus) => {
      const tileIdToUpdate = selectedTile.id; // Capture ID before navigation

      // Set optimistic status immediately for instant UI feedback
      const updatedStatuses = new Map(optimisticStatuses);
      updatedStatuses.set(tileIdToUpdate, status);
      setOptimisticStatuses(updatedStatuses);

      // CRITICAL: Update the ref synchronously so findNextPendingTile sees the change
      optimisticStatusesRef.current = updatedStatuses;

      // Wait briefly to show visual feedback, then advance
      setTimeout(() => {
        // Auto-advance to next pending tile
        const next = findNextPendingTile();
        if (next) {
          onTileSelect(next.id);
        } else {
          // No more pending tiles - all complete! Just deselect immediately
          onTileSelect(null);
        }

        // Update status in background after navigating
        onStatusUpdate(tileIdToUpdate, status).then(() => {
          // Clear optimistic status after DB update completes
          setOptimisticStatuses((prev) => {
            const next = new Map(prev);
            next.delete(tileIdToUpdate);
            return next;
          });
          // Also clear from ref
          optimisticStatusesRef.current.delete(tileIdToUpdate);
        });
      }, 250); // Visual feedback delay - show button selection before navigating
    },
    [selectedTile, findNextPendingTile, onStatusUpdate, onTileSelect, optimisticStatuses],
  );

  // Check if all tiles are completed
  const isComplete = baseTileProgress.percent === 100;

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return; // Don't trigger shortcuts when typing
      }

      switch (e.key.toLowerCase()) {
        case " ": // Space key for Good
          e.preventDefault();
          handleStatusChangeWithAdvance("good");
          break;
        case "f": // F key for Bad
          e.preventDefault();
          handleStatusChangeWithAdvance("bad");
          break;
        case "arrowright":
        case "arrowdown":
          e.preventDefault();
          handleNext();
          break;
        case "arrowleft":
        case "arrowup":
          e.preventDefault();
          handlePrevious();
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleNext, handlePrevious, handleStatusChangeWithAdvance]);

  return (
    <div className="flex h-full w-96 flex-shrink-0 flex-col border-l bg-gray-50">
      {/* Base Tile Summary */}
      <Card size="small" className="border-0 border-b border-t p-2">
        <div className="mb-3">
          <Typography.Text strong>Base Tile: {baseTile.tile_index}</Typography.Text>
          {isComplete && (
            <div className="mt-2 flex items-center gap-2 text-green-600">
              <CheckCircleOutlined />
              <span className="font-medium">Complete!</span>
            </div>
          )}
        </div>
        {hasSubTiles && (
          <Space direction="vertical" size="small" className="w-full">
            <div className="flex justify-between gap-4">
              <div>
                <div className="mb-1 text-xs text-gray-500">10cm Tiles</div>
                <div className="text-base">
                  <span className="font-semibold">{baseTileProgress.completed10}</span>{" "}
                  <span className="text-gray-400">/</span>{" "}
                  <span className="text-gray-500">{baseTileProgress.total10}</span>
                </div>
              </div>
              <div>
                <div className="mb-1 text-xs text-gray-500">5cm Tiles</div>
                <div className="text-base">
                  <span className="font-semibold">{baseTileProgress.completed5}</span>{" "}
                  <span className="text-gray-400">/</span>{" "}
                  <span className="text-gray-500">{baseTileProgress.total5}</span>
                </div>
              </div>
            </div>
            <div>
              <div className="mb-1 text-xs text-gray-500">Progress</div>
              <Progress percent={baseTileProgress.percent} />
            </div>
          </Space>
        )}
      </Card>

      {/* Resolution Selector - only show if sub-tiles exist */}
      {hasSubTiles && (
        <Tabs
          activeKey={selectedResolution.toString()}
          onChange={(key) => onResolutionChange(Number(key) as TileResolution)}
          items={[
            ...(baseTile.status === "pending"
              ? [
                  {
                    key: "20",
                    label: "20cm",
                  },
                ]
              : []),
            {
              key: "10",
              label: "10cm",
            },
            {
              key: "5",
              label: "5cm",
            },
          ]}
          size="large"
          centered
        />
      )}

      {/* Action Buttons - only show if sub-tiles exist */}
      {hasSubTiles && (
        <div className="flex-1">
          {/* Row 1: Rating Radio Group */}
          <div className="border-b p-4">
            <div className="mb-2 text-sm text-gray-600">Rate this tile:</div>
            <Radio.Group
              key={`radio-${selectedTile.id}-${displayStatus}`}
              value={displayStatus === "pending" ? undefined : displayStatus}
              onChange={(e) => handleRadioStatusChange(e.target.value as TileStatus)}
              buttonStyle="solid"
              size="large"
              className="w-full"
            >
              <Radio.Button value="good" className="w-1/2 text-center">
                Good (Space)
              </Radio.Button>
              <Radio.Button value="bad" className="w-1/2 text-center">
                Bad (F)
              </Radio.Button>
            </Radio.Group>
            {displayStatus !== "pending" && !isDelayingNavigation && (
              <Button block onClick={handleClearRating} className="mt-3">
                Clear Rating
              </Button>
            )}
          </div>

          {/* Row 2: Navigation Buttons */}
          <div className="flex-1 border-b p-4">
            <div className="flex w-full items-center justify-center gap-2">
              <Button icon={<LeftOutlined />} onClick={handlePrevious} disabled={currentIndex === 0} className="px-4" />
              <Button onClick={handleJumpToNextPending} className="flex-1 px-4">
                Go to Next Pending
              </Button>
              <Button
                icon={<RightOutlined />}
                onClick={handleNext}
                disabled={currentIndex === sortedTiles.length - 1}
                className="px-4"
              />
            </div>

            {/* Tile info */}
            <div className="mt-3 text-center">
              <Typography.Text type="secondary" className="text-xs">
                Tile {currentIndex + 1} of {sortedTiles.length} • {selectedTile.tile_index}
              </Typography.Text>
            </div>
          </div>
        </div>
      )}

      {/* Initial Base Tile: Generate Sub-tiles */}
      {!hasSubTiles && selectedTile.resolution_cm === 20 && selectedTile.status === "pending" && onGenerateSubTiles && (
        <div className="flex-1 p-4">
          <Space direction="vertical" size="middle" className="w-full">
            <Alert
              message="Ready to Generate Sub-tiles"
              description="Position the base tile correctly, then generate all nested tiles (4×10cm + 16×5cm). After generation, the tile cannot be moved."
              type="info"
              showIcon
            />
            <Button
              type="primary"
              block
              size="large"
              icon={<ThunderboltOutlined />}
              onClick={handleGenerateSubTiles}
              loading={isGenerating}
            >
              Generate Sub-tiles
            </Button>
          </Space>
        </div>
      )}

      {/* Delete Button - always at bottom */}
      <div className="mt-auto border-t p-4">
        <Button danger block icon={<DeleteOutlined />} onClick={() => onDelete(selectedTile.id)}>
          Delete Tile
        </Button>
      </div>
    </div>
  );
}
