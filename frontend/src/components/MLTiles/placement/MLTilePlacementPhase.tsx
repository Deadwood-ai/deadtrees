import { useMemo, useState, useCallback } from "react";
import { Button, Divider, List, Space, Tag, Typography, message } from "antd";
import { PlusOutlined, DeleteOutlined } from "@ant-design/icons";
import { IDataset } from "../../../types/dataset";
import { IMLTile, TileResolution } from "../../../types/mlTiles";
import { useCreateMLTile, useDeleteMLTile, useMLTiles } from "../../../hooks/useMLTiles";
import { useDatasetAOI } from "../../../hooks/useDatasetAudit";
import {
  polygon as turfPolygon,
  multiPolygon as turfMultiPolygon,
  area,
  intersect,
  centroid,
  feature,
} from "@turf/turf";
import GeoJSON from "ol/format/GeoJSON";

interface Props {
  dataset: IDataset;
  onUnsavedChanges: (hasChanges: boolean) => void;
  onNavigateToQA: () => void;
}

const PlacementGuidelines = () => (
  <div className="rounded-md border border-dashed border-blue-200 bg-blue-50 p-3 text-sm text-blue-700">
    <b>Guidelines:</b> Place base 20cm tiles covering high-quality regions. Each tile must have ≥60% overlap with the
    AOI with no overlap between tiles.
  </div>
);

export default function MLTilePlacementPhase({ dataset, onUnsavedChanges, onNavigateToQA }: Props) {
  const { data: tiles = [], isLoading } = useMLTiles(dataset.id, 20);
  const { data: aoiData } = useDatasetAOI(dataset.id);
  const { mutateAsync: createTile } = useCreateMLTile();
  const { mutateAsync: deleteTile } = useDeleteMLTile();
  const [isSaving, setIsSaving] = useState(false);

  const geoJson = useMemo(() => new GeoJSON(), []);

  const aoiGeometry = useMemo(() => {
    if (!aoiData?.geometry) return null;
    try {
      return geoJson.readGeometry(aoiData.geometry, {
        dataProjection: "EPSG:4326",
        featureProjection: "EPSG:3857",
      });
    } catch (error) {
      console.warn("Failed to parse AOI geometry", error);
      return null;
    }
  }, [aoiData?.geometry, geoJson]);

  const aoiGeoJSON = useMemo(() => {
    if (!aoiGeometry) return null;
    return geoJson.writeGeometryObject(aoiGeometry) as GeoJSON.Polygon | GeoJSON.MultiPolygon;
  }, [aoiGeometry, geoJson]);

  const aoiCentroid = useMemo(() => {
    if (!aoiGeoJSON) return null;
    const turfGeom =
      aoiGeoJSON.type === "Polygon"
        ? turfPolygon(aoiGeoJSON.coordinates as GeoJSON.Position[][])
        : turfMultiPolygon(aoiGeoJSON.coordinates as GeoJSON.Position[][][]);
    return centroid(turfGeom).geometry.coordinates as [number, number];
  }, [aoiGeoJSON]);

  const validateTilePlacement = useCallback(
    (geometry: GeoJSON.Polygon, resolution: TileResolution) => {
      if (!aoiGeoJSON) return { ok: true };

      try {
        const tileFeat = feature(geometry);
        const aoiFeat = feature(aoiGeoJSON);

        const overlap = intersect(tileFeat, aoiFeat);
        if (!overlap) {
          return { ok: false, message: "Tile does not intersect the AOI." };
        }
        const overlapPct = (area(overlap) / area(tileFeat)) * 100;
        if (overlapPct < 60) {
          return { ok: false, message: `Tile AOI overlap is only ${overlapPct.toFixed(1)}%. Minimum is 60%.` };
        }
        if (tiles.some((t) => t.resolution_cm === resolution && intersectsTile(t.geometry as any, geometry))) {
          return { ok: false, message: "Tile overlaps an existing tile." };
        }

        return { ok: true, overlap: overlapPct };
      } catch (error) {
        console.error("Validation error:", error);
        return { ok: false, message: `Validation error: ${error}` };
      }
    },
    [aoiGeoJSON, tiles],
  );

  const handleCreateTile = async () => {
    if (!aoiGeoJSON || !aoiCentroid) {
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
      setIsSaving(true);
      await createTile({
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
        aoi_coverage_percent: 100, // Will be calculated on map
        deadwood_prediction_coverage_percent: null,
        forest_cover_prediction_coverage_percent: null,
      });
      onUnsavedChanges(true);
      message.success("Tile created.");
    } catch (error) {
      console.error(error);
      message.error("Failed to create tile");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteTile = async (tile: IMLTile) => {
    try {
      await deleteTile({ tileId: tile.id, datasetId: dataset.id });
      onUnsavedChanges(true);
      message.success("Tile deleted");
    } catch (error) {
      console.error(error);
      message.error("Failed to delete tile");
    }
  };

  return (
    <div className="flex h-full w-full flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <div>
          <Typography.Title level={4} style={{ marginBottom: 4 }}>
            Phase 1: Place Base Tiles
          </Typography.Title>
          <Typography.Text type="secondary">
            Create 20cm tiles covering AOI. Avoid overlap and ensure sufficient coverage.
          </Typography.Text>
        </div>
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleCreateTile} loading={isSaving}>
            Add Base Tile
          </Button>
          <Button disabled={tiles.length === 0} onClick={onNavigateToQA}>
            Continue to QA
          </Button>
        </Space>
      </div>

      <PlacementGuidelines />

      <Divider orientation="left">Existing Tiles</Divider>
      <List
        bordered
        dataSource={tiles}
        loading={isLoading}
        locale={{ emptyText: "No tiles placed yet." }}
        renderItem={(tile) => (
          <List.Item
            actions={[
              <Button
                key="delete"
                icon={<DeleteOutlined />}
                danger
                type="text"
                onClick={() => handleDeleteTile(tile)}
              />,
            ]}
          >
            <List.Item.Meta
              title={
                <Space>
                  <span className="font-medium">{tile.tile_index}</span>
                  <Tag color="blue">{tile.resolution_cm} cm</Tag>
                  <Tag>{tile.status}</Tag>
                </Space>
              }
              description={
                <Space size="large">
                  <span>AOI overlap: {tile.aoi_coverage_percent ? `${tile.aoi_coverage_percent}%` : "n/a"}</span>
                  <span>
                    Bounds: {tile.bbox_minx.toFixed(1)}, {tile.bbox_miny.toFixed(1)} × {tile.bbox_maxx.toFixed(1)},{" "}
                    {tile.bbox_maxy.toFixed(1)}
                  </span>
                </Space>
              }
            />
          </List.Item>
        )}
      />
    </div>
  );
}

function boundingBoxFromGeoJSON(geometry: GeoJSON.Geometry): {
  minx: number;
  miny: number;
  maxx: number;
  maxy: number;
} {
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;

  const polygons =
    geometry.type === "Polygon" ? [geometry.coordinates] : (geometry as GeoJSON.MultiPolygon).coordinates;
  polygons.forEach((poly) => {
    poly[0].forEach(([x, y]) => {
      minx = Math.min(minx, x);
      miny = Math.min(miny, y);
      maxx = Math.max(maxx, x);
      maxy = Math.max(maxy, y);
    });
  });

  return { minx, miny, maxx, maxy };
}

function intersectsTile(a: GeoJSON.Polygon, b: GeoJSON.Polygon) {
  const ap = turfPolygon(a.coordinates as GeoJSON.Position[][]);
  const bp = turfPolygon(b.coordinates as GeoJSON.Position[][]);
  return !!intersect(ap, bp);
}
