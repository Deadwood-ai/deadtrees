import { useMemo, useState } from "react";
import { Button, Divider, List, Space, Tag, Typography, message } from "antd";
import { PlusOutlined, DeleteOutlined } from "@ant-design/icons";
import { IDataset } from "../../../types/dataset";
import { IReferencePatch } from "../../../types/referencePatches";
import {
  useCreateReferencePatch,
  useDeleteReferencePatch,
  useReferencePatches,
} from "../../../hooks/useReferencePatches";
import { useDatasetAOI } from "../../../hooks/useDatasetAudit";
import { polygon as turfPolygon, multiPolygon as turfMultiPolygon, centroid } from "@turf/turf";
import GeoJSON from "ol/format/GeoJSON";

interface Props {
  dataset: IDataset;
  onUnsavedChanges: (hasChanges: boolean) => void;
  onNavigateToQA: () => void;
}

const PlacementGuidelines = () => (
  <div className="rounded-md border border-dashed border-blue-200 bg-blue-50 p-3 text-sm text-blue-700">
    <b>Guidelines:</b> Place base 20cm patches covering high-quality regions. Each patch must have ≥60% overlap with the
    AOI with no overlap between patches.
  </div>
);

export default function PatchPlacementPhase({ dataset, onUnsavedChanges, onNavigateToQA }: Props) {
  const { data: patches = [], isLoading } = useReferencePatches(dataset.id, 20);
  const { data: aoiData } = useDatasetAOI(dataset.id);
  const { mutateAsync: createPatch } = useCreateReferencePatch();
  const { mutateAsync: deletePatch } = useDeleteReferencePatch();
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

  const handleCreatePatch = async () => {
    if (!aoiGeoJSON || !aoiCentroid) {
      message.warning("AOI required before placing base patches.");
      return;
    }

    // Calculate UTM zone and create patch in UTM coordinates
    const { getUtmZoneFromWebMercator, webMercatorToUtm, createUtmSquare, getTargetGroundSize, getUtmEpsgCode } =
      await import("../../../utils/utm");

    const utmZone = getUtmZoneFromWebMercator(aoiCentroid[0], aoiCentroid[1]);
    const epsgCode = getUtmEpsgCode(utmZone);
    const [centerUtmX, centerUtmY] = webMercatorToUtm(aoiCentroid[0], aoiCentroid[1], utmZone);
    const targetGroundSize = getTargetGroundSize(20); // 204.8m for 20cm resolution
    const patchGeometry = createUtmSquare(centerUtmX, centerUtmY, targetGroundSize);

    if (patches.length > 0) {
      message.info("This dataset already has a base patch.");
      return;
    }

    try {
      setIsSaving(true);
      await createPatch({
        dataset_id: dataset.id,
        resolution_cm: 20,
        geometry: patchGeometry,
        utm_zone: utmZone,
        epsg_code: epsgCode,
        parent_tile_id: null,
        patch_index: `20_${Date.now()}`,
        bbox_minx: patchGeometry.coordinates[0][0][0],
        bbox_miny: patchGeometry.coordinates[0][0][1],
        bbox_maxx: patchGeometry.coordinates[0][2][0],
        bbox_maxy: patchGeometry.coordinates[0][2][1],
        aoi_coverage_percent: 100, // Will be calculated on map
        deadwood_prediction_coverage_percent: null,
        forest_cover_prediction_coverage_percent: null,
      });
      onUnsavedChanges(true);
      message.success("Patch created.");
    } catch (error) {
      console.error(error);
      message.error("Failed to create patch");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeletePatch = async (patch: IReferencePatch) => {
    try {
      await deletePatch({ patchId: patch.id, datasetId: dataset.id });
      onUnsavedChanges(true);
      message.success("Patch deleted");
    } catch (error) {
      console.error(error);
      message.error("Failed to delete patch");
    }
  };

  return (
    <div className="flex h-full w-full flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <div>
          <Typography.Title level={4} style={{ marginBottom: 4 }}>
            Phase 1: Place Base Patches
          </Typography.Title>
          <Typography.Text type="secondary">
            Create 20cm patches covering AOI. Avoid overlap and ensure sufficient coverage.
          </Typography.Text>
        </div>
        <Space>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={handleCreatePatch}
            loading={isSaving}
            disabled={patches.length > 0}
            title={patches.length > 0 ? "This dataset already has a base patch." : undefined}
          >
            Add Base Patch
          </Button>
          <Button disabled={patches.length === 0} onClick={onNavigateToQA}>
            Continue to QA
          </Button>
        </Space>
      </div>

      <PlacementGuidelines />

      <Divider orientation="left">Existing Patches</Divider>
      <List
        bordered
        dataSource={patches}
        loading={isLoading}
        locale={{ emptyText: "No patches placed yet." }}
        renderItem={(patch) => (
          <List.Item
            actions={[
              <Button
                key="delete"
                icon={<DeleteOutlined />}
                danger
                type="text"
                onClick={() => handleDeletePatch(patch)}
              />,
            ]}
          >
            <List.Item.Meta
              title={
                <Space>
                  <span className="font-medium">{patch.patch_index}</span>
                  <Tag color="blue">{patch.resolution_cm} cm</Tag>
                  <Tag>
                    {patch.deadwood_validated === null && patch.forest_cover_validated === null ? "pending" : "reviewed"}
                  </Tag>
                </Space>
              }
              description={
                <Space size="large">
                  <span>AOI overlap: {patch.aoi_coverage_percent ? `${patch.aoi_coverage_percent}%` : "n/a"}</span>
                  <span>
                    Bounds: {patch.bbox_minx.toFixed(1)}, {patch.bbox_miny.toFixed(1)} × {patch.bbox_maxx.toFixed(1)},{" "}
                    {patch.bbox_maxy.toFixed(1)}
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
