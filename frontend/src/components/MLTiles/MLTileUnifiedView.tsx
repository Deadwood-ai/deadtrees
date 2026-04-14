import { useState, useCallback, useMemo, useEffect } from "react";
import { IDataset } from "../../types/dataset";
import { IMLTile, TileResolution } from "../../types/mlTiles";
import { useMLTiles, useCreateMLTile, useUpdateTileStatus, useDeleteMLTile } from "../../hooks/useMLTiles";
import { useDatasetAOI } from "../../hooks/useDatasetAudit";
import { message, Button, Alert, Modal } from "antd";
import { PlusOutlined, LockOutlined, EditOutlined, ExclamationCircleOutlined } from "@ant-design/icons";
import { polygon as turfPolygon, multiPolygon as turfMultiPolygon, centroid } from "@turf/turf";
import GeoJSON from "ol/format/GeoJSON";
import MLTileMap from "./MLTileMap";
import MLTileDetailSidebar from "./MLTileDetailSidebar";

interface Props {
  dataset: IDataset;
  onUnsavedChanges: (hasChanges: boolean) => void;
  isCompleted: boolean;
  onReopenForEditing: () => void;
}

export default function MLTileUnifiedView({ dataset, onUnsavedChanges, isCompleted, onReopenForEditing }: Props) {
  const [selectedResolution, setSelectedResolution] = useState<TileResolution>(20);
  const [selectedTileId, setSelectedTileId] = useState<number | null>(null);
  const [getTileGeometryFromMap, setGetTileGeometryFromMap] = useState<
    ((tileId: number) => GeoJSON.Polygon | null) | null
  >(null);
  const [layerToggles, setLayerToggles] = useState<{
    toggleAOI: () => void;
    toggleDeadwood: () => void;
    toggleForestCover: () => void;
  } | null>(null);

  const { data: allTiles = [], refetch: refetchTiles } = useMLTiles(dataset.id);
  const { data: aoiData } = useDatasetAOI(dataset.id);
  const { mutateAsync: createTile } = useCreateMLTile();
  const { mutateAsync: updateStatus } = useUpdateTileStatus();
  const { mutateAsync: deleteTile } = useDeleteMLTile();

  const geoJson = useMemo(() => new GeoJSON(), []);

  // Get base tiles (20cm) and calculate AOI centroid
  const baseTiles = useMemo(() => allTiles.filter((t) => t.resolution_cm === 20), [allTiles]);

  const aoiCentroid = useMemo(() => {
    if (!aoiData?.geometry) return null;
    try {
      const aoiGeometry = geoJson.readGeometry(aoiData.geometry, {
        dataProjection: "EPSG:4326",
        featureProjection: "EPSG:3857",
      });
      const aoiGeoJSON = geoJson.writeGeometryObject(aoiGeometry) as GeoJSON.Polygon | GeoJSON.MultiPolygon;
      const turfGeom =
        aoiGeoJSON.type === "Polygon"
          ? turfPolygon(aoiGeoJSON.coordinates as GeoJSON.Position[][])
          : turfMultiPolygon(aoiGeoJSON.coordinates as GeoJSON.Position[][][]);
      return centroid(turfGeom).geometry.coordinates as [number, number];
    } catch (error) {
      console.error("Failed to calculate AOI centroid:", error);
      return null;
    }
  }, [aoiData?.geometry, geoJson]);

  // Filter tiles for map display
  // Always show base tiles (20cm) + tiles at selected resolution
  const tilesForResolution = useMemo(() => {
    if (selectedResolution === 20) {
      // If viewing 20cm, only show 20cm tiles
      return allTiles.filter((t) => t.resolution_cm === 20);
    } else {
      // If viewing 10cm or 5cm, show base tiles (20cm) + the selected resolution
      return allTiles.filter((t) => t.resolution_cm === 20 || t.resolution_cm === selectedResolution);
    }
  }, [allTiles, selectedResolution]);

  // Get the selected tile
  const selectedTile = useMemo(() => allTiles.find((t) => t.id === selectedTileId) || null, [allTiles, selectedTileId]);

  // Get base tile for selected tile
  const selectedBaseTile = useMemo(() => {
    if (!selectedTile) return null;
    if (selectedTile.resolution_cm === 20) return selectedTile;
    // Find parent base tile by parsing tile_index
    const baseIndex = selectedTile.tile_index.split("_")[0] + "_" + selectedTile.tile_index.split("_")[1];
    return baseTiles.find((t) => t.tile_index === baseIndex) || null;
  }, [selectedTile, baseTiles]);

  // Recursively generate nested tiles
  const generateNestedTilesRecursive = useCallback(
    async (parentTile: IMLTile) => {
      const parentGeom = parentTile.geometry;
      const parentCoords = parentGeom.coordinates[0];
      const [minx, miny] = parentCoords[0];
      const [maxx, maxy] = parentCoords[2];
      const centerX = (minx + maxx) / 2;
      const centerY = (miny + maxy) / 2;
      const halfWidth = (maxx - minx) / 2;
      const halfHeight = (maxy - miny) / 2;

      const childResolution = parentTile.resolution_cm === 20 ? 10 : 5;
      const positions = [
        [centerX - halfWidth / 2, centerY - halfHeight / 2],
        [centerX + halfWidth / 2, centerY - halfHeight / 2],
        [centerX - halfWidth / 2, centerY + halfHeight / 2],
        [centerX + halfWidth / 2, centerY + halfHeight / 2],
      ];

      // Create all 4 child tiles in parallel for better performance
      const tileCreationPromises = positions.map((position, i) => {
        const [cx, cy] = position;
        const childGeometry: GeoJSON.Polygon = {
          type: "Polygon",
          coordinates: [
            [
              [cx - halfWidth / 2, cy - halfHeight / 2],
              [cx + halfWidth / 2, cy - halfHeight / 2],
              [cx + halfWidth / 2, cy + halfHeight / 2],
              [cx - halfWidth / 2, cy + halfHeight / 2],
              [cx - halfWidth / 2, cy - halfHeight / 2],
            ],
          ],
        };

        return createTile({
          dataset_id: dataset.id,
          resolution_cm: childResolution,
          geometry: childGeometry,
          parent_tile_id: parentTile.id,
          status: "pending",
          tile_index: `${parentTile.tile_index}_${i}`,
          bbox_minx: childGeometry.coordinates[0][0][0],
          bbox_miny: childGeometry.coordinates[0][0][1],
          bbox_maxx: childGeometry.coordinates[0][2][0],
          bbox_maxy: childGeometry.coordinates[0][2][1],
          aoi_coverage_percent: null,
          deadwood_prediction_coverage_percent: null,
          forest_cover_prediction_coverage_percent: null,
        });
      });

      const childTiles = await Promise.all(tileCreationPromises);

      // If we just created 10cm tiles, recursively create 5cm tiles in parallel
      if (childResolution === 10) {
        await Promise.all(childTiles.map((child) => generateNestedTilesRecursive(child as IMLTile)));
      }
    },
    [createTile, dataset.id],
  );

  // Handle adding a new base tile (without auto-generating children)
  const handleAddBaseTile = useCallback(async () => {
    if (!aoiCentroid) {
      message.warning("AOI required before placing base tiles.");
      return;
    }

    const targetSizeMeters = 204.8;
    const tileGeometry: GeoJSON.Polygon = {
      type: "Polygon",
      coordinates: [
        [
          [aoiCentroid[0] - targetSizeMeters / 2, aoiCentroid[1] - targetSizeMeters / 2],
          [aoiCentroid[0] + targetSizeMeters / 2, aoiCentroid[1] - targetSizeMeters / 2],
          [aoiCentroid[0] + targetSizeMeters / 2, aoiCentroid[1] + targetSizeMeters / 2],
          [aoiCentroid[0] - targetSizeMeters / 2, aoiCentroid[1] + targetSizeMeters / 2],
          [aoiCentroid[0] - targetSizeMeters / 2, aoiCentroid[1] - targetSizeMeters / 2],
        ],
      ],
    };

    try {
      // Create base tile in pending state (user will position it, then generate children)
      const newTile = await createTile({
        dataset_id: dataset.id,
        resolution_cm: 20,
        geometry: tileGeometry,
        parent_tile_id: null,
        status: "pending",
        tile_index: `20_${Date.now()}`,
        bbox_minx: tileGeometry.coordinates[0][0][0],
        bbox_miny: tileGeometry.coordinates[0][0][1],
        bbox_maxx: tileGeometry.coordinates[0][2][0],
        bbox_maxy: tileGeometry.coordinates[0][2][1],
        aoi_coverage_percent: 100,
        deadwood_prediction_coverage_percent: null,
        forest_cover_prediction_coverage_percent: null,
      });

      // Explicitly refetch to ensure UI updates immediately
      await refetchTiles();

      // Auto-select the newly created tile
      if (newTile && newTile.id) {
        setSelectedTileId(newTile.id);
        setSelectedResolution(20);
      }

      onUnsavedChanges(true);
      message.success("Base tile created. Drag it to position, then select it to generate sub-tiles.");
    } catch (error) {
      console.error(error);
      message.error("Failed to create base tile");
    }
  }, [aoiCentroid, dataset.id, createTile, onUnsavedChanges, refetchTiles]);

  // Handle tile selection
  const handleTileSelected = useCallback((tile: IMLTile | null) => {
    if (tile) {
      setSelectedTileId(tile.id);
      setSelectedResolution(tile.resolution_cm);
    } else {
      setSelectedTileId(null);
    }
  }, []);

  // Memoize the callback that receives the tile geometry getter
  const handleGetTileGeometry = useCallback((getter: (tileId: number) => GeoJSON.Polygon | null) => {
    setGetTileGeometryFromMap(() => getter);
  }, []);

  // Memoize the callback that receives layer toggle functions
  const handleGetLayerToggles = useCallback(
    (toggles: { toggleAOI: () => void; toggleDeadwood: () => void; toggleForestCover: () => void }) => {
      setLayerToggles(toggles);
    },
    [],
  );

  // Handle generating sub-tiles for a base tile
  const handleGenerateSubTiles = useCallback(
    async (baseTile: IMLTile, currentGeometry?: GeoJSON.Polygon) => {
      try {
        message.loading({ content: "Generating nested tiles...", key: "generate" });

        // Get current geometry from map if available, otherwise use provided or baseTile geometry
        // This ensures we use the MOVED position if the user translated the tile
        let geometryToUse = currentGeometry || baseTile.geometry;

        if (!currentGeometry && getTileGeometryFromMap) {
          const mapGeometry = getTileGeometryFromMap(baseTile.id);
          if (mapGeometry) {
            geometryToUse = mapGeometry;
          }
        }

        const tileToGenerate =
          geometryToUse !== baseTile.geometry ? { ...baseTile, geometry: geometryToUse } : baseTile;

        await generateNestedTilesRecursive(tileToGenerate);
        // Mark base tile as good
        await updateStatus({ tileId: baseTile.id, status: "good" });
        onUnsavedChanges(true);
        message.success({ content: "All nested tiles generated successfully!", key: "generate" });

        // Switch to 10cm resolution
        setSelectedResolution(10);

        // Small delay to allow React Query to update the tiles list
        setTimeout(() => {
          // Auto-select first 10cm tile to start checking
          const firstChild = allTiles.find(
            (t) => t.parent_tile_id === baseTile.id && t.resolution_cm === 10 && t.status === "pending",
          );
          if (firstChild) {
            setSelectedTileId(firstChild.id);
          }
        }, 100);
      } catch (error) {
        console.error(error);
        message.error({ content: "Failed to generate tiles", key: "generate" });
      }
    },
    [generateNestedTilesRecursive, updateStatus, onUnsavedChanges, allTiles, getTileGeometryFromMap],
  );

  // Global keyboard shortcuts for layer toggles (work even without tile selection)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger when typing in input fields
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      // Only handle layer toggle keys
      switch (e.key.toLowerCase()) {
        case "j":
          e.preventDefault();
          layerToggles?.toggleAOI();
          break;
        case "k":
          e.preventDefault();
          layerToggles?.toggleDeadwood();
          break;
        case "l":
          e.preventDefault();
          layerToggles?.toggleForestCover();
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [layerToggles]);

  return (
    <div className="flex h-full w-full flex-col">
      {/* Completion Status Banner */}
      {isCompleted && (
        <Alert
          message="Dataset Marked as Complete"
          description={
            <div className="flex items-center justify-between">
              <span>This dataset has been marked as ML tiles complete. To make changes, reopen it for editing.</span>
              <Button icon={<EditOutlined />} onClick={onReopenForEditing} size="small">
                Reopen for Editing
              </Button>
            </div>
          }
          type="success"
          icon={<LockOutlined />}
          showIcon
          className="m-4"
        />
      )}

      {/* Main Content: Map + Sidebar */}
      <div className="flex min-h-0 flex-1">
        {/* Map */}
        <div className="relative flex-1">
          <MLTileMap
            datasetId={dataset.id}
            cogPath={dataset.cog_path}
            resolution={selectedResolution}
            tiles={tilesForResolution}
            onTileSelected={handleTileSelected}
            enableTranslation={true}
            focusTileId={selectedTileId}
            onGetTileGeometry={handleGetTileGeometry}
            onGetLayerToggles={handleGetLayerToggles}
          />

          {/* Add Base Tile Button (overlay) - show when no tile is selected and not completed */}
          {!selectedTile && !isCompleted && (
            <div className="pointer-events-none absolute left-4 top-4 z-10">
              <Button icon={<PlusOutlined />} onClick={handleAddBaseTile} className="pointer-events-auto shadow-lg">
                Add Base Tile
              </Button>
            </div>
          )}
        </div>

        {/* Sidebar (only visible when a tile is selected) */}
        {selectedTile && selectedBaseTile && (
          <MLTileDetailSidebar
            baseTile={selectedBaseTile}
            selectedTile={selectedTile}
            selectedResolution={selectedResolution}
            allTiles={allTiles}
            onResolutionChange={setSelectedResolution}
            onTileSelect={setSelectedTileId}
            onStatusUpdate={async (tileId: number, status: "good" | "bad" | "pending") => {
              await updateStatus({ tileId, status });
              onUnsavedChanges(true);
            }}
            onDelete={async (tileId: number) => {
              // Find the tile being deleted
              const tileToDelete = allTiles.find((t) => t.id === tileId);
              if (!tileToDelete) return;

              // Always delete the entire base tile family
              // First, find the base tile (20cm)
              let baseTile: IMLTile;
              if (tileToDelete.resolution_cm === 20) {
                baseTile = tileToDelete;
              } else {
                // Walk up the parent chain to find the base tile
                let current = tileToDelete;
                while (current.parent_tile_id) {
                  const parent = allTiles.find((t) => t.id === current.parent_tile_id);
                  if (!parent) break;
                  current = parent;
                }
                baseTile = current;
              }

              // Find all descendants of the base tile
              const tilesToDelete: IMLTile[] = [baseTile];

              // Find all direct children (10cm tiles)
              const children10cm = allTiles.filter((t) => t.parent_tile_id === baseTile.id);
              tilesToDelete.push(...children10cm);

              // Find all grandchildren (5cm tiles)
              for (const child of children10cm) {
                const children5cm = allTiles.filter((t) => t.parent_tile_id === child.id);
                tilesToDelete.push(...children5cm);
              }

              // Show confirmation modal with completion warning if applicable
              const completionWarning = isCompleted
                ? "\n\n⚠️ Warning: Deleting tiles will automatically reset this dataset's completion status. You'll need to mark it as complete again after making changes."
                : "";

              Modal.confirm({
                title: "Delete Entire Base Tile?",
                icon: <ExclamationCircleOutlined />,
                content: `This will delete the base tile and all ${tilesToDelete.length - 1} sub-tiles.${completionWarning}`,
                okText: "Delete All",
                okType: "danger",
                cancelText: "Cancel",
                onOk: async () => {
                  // Delete all tiles in the family in parallel for better performance
                  message.loading({
                    content: `Deleting base tile and ${tilesToDelete.length - 1} sub-tiles...`,
                    key: "delete",
                  });

                  await Promise.all(
                    tilesToDelete.map((tile) => deleteTile({ tileId: tile.id, datasetId: dataset.id })),
                  );

                  // If dataset was marked as complete, automatically reset it
                  if (isCompleted) {
                    await onReopenForEditing();
                    message.success({
                      content: "Tiles deleted and dataset reopened for editing",
                      key: "delete",
                    });
                  } else {
                    message.success({ content: "All tiles deleted successfully!", key: "delete" });
                  }

                  setSelectedTileId(null);
                  onUnsavedChanges(true);
                },
              });
            }}
            onGenerateSubTiles={handleGenerateSubTiles}
          />
        )}
      </div>
    </div>
  );
}
