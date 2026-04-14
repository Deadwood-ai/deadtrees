# ML Training Tile Generation - Implementation Plan

## Overview

Generate gold standard training datasets from audited datasets by creating multi-resolution tiles (5cm, 10cm, 20cm GSD) with manual quality control. Store validated tile regions as polygons for batch PNG export.

## Goals

1. Enable auditors to manually place and validate 1024×1024 pixel tiles at three resolutions
2. Implement two-phase QA workflow: initial sequential review + optional validation
3. Store tile geometries with prediction coverage metadata
4. Integrate into Dataset Audit workflow as optional step
5. Support session locking to prevent concurrent edits

## Architecture

### Database Schema

#### New Table: `ml_training_tiles`

```sql
CREATE TABLE ml_training_tiles (
  id BIGSERIAL PRIMARY KEY,
  dataset_id BIGINT NOT NULL REFERENCES v2_datasets(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  resolution_cm INTEGER NOT NULL CHECK (resolution_cm IN (5, 10, 20)),
  geometry JSONB NOT NULL, -- GeoJSON Polygon in EPSG:3857
  parent_tile_id BIGINT REFERENCES ml_training_tiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'good', 'bad')),
  tile_index VARCHAR(50) NOT NULL, -- e.g., "20_0", "10_0_2", "5_0_2_3" for hierarchical addressing

  -- Metadata for export
  bbox_minx DOUBLE PRECISION NOT NULL,
  bbox_miny DOUBLE PRECISION NOT NULL,
  bbox_maxx DOUBLE PRECISION NOT NULL,
  bbox_maxy DOUBLE PRECISION NOT NULL,

  -- Coverage statistics (0-100 percentages)
  aoi_coverage_percent SMALLINT CHECK (aoi_coverage_percent >= 0 AND aoi_coverage_percent <= 100),
  deadwood_prediction_coverage_percent SMALLINT CHECK (deadwood_prediction_coverage_percent >= 0 AND deadwood_prediction_coverage_percent <= 100),
  forest_cover_prediction_coverage_percent SMALLINT CHECK (forest_cover_prediction_coverage_percent >= 0 AND forest_cover_prediction_coverage_percent <= 100),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT ml_tiles_unique_index UNIQUE (dataset_id, tile_index)
);

-- Indexes
CREATE INDEX idx_ml_tiles_dataset ON ml_training_tiles(dataset_id);
CREATE INDEX idx_ml_tiles_status ON ml_training_tiles(status, resolution_cm);
CREATE INDEX idx_ml_tiles_resolution ON ml_training_tiles(resolution_cm);
CREATE INDEX idx_ml_tiles_parent ON ml_training_tiles(parent_tile_id) WHERE parent_tile_id IS NOT NULL;

-- RLS Policies
ALTER TABLE ml_training_tiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Auditors can view all tiles" ON ml_training_tiles
  FOR SELECT USING (
    auth.uid() IN (SELECT user_id FROM privileged_users WHERE can_audit = true)
  );

CREATE POLICY "Auditors can manage tiles" ON ml_training_tiles
  FOR ALL USING (
    auth.uid() IN (SELECT user_id FROM privileged_users WHERE can_audit = true)
  );
```

#### Add Session Tracking to `v2_statuses`

```sql
ALTER TABLE v2_statuses
ADD COLUMN is_in_tile_generation BOOLEAN DEFAULT FALSE,
ADD COLUMN tile_generation_locked_by UUID REFERENCES auth.users(id),
ADD COLUMN tile_generation_locked_at TIMESTAMPTZ;

-- Index for lock queries
CREATE INDEX idx_statuses_tile_lock ON v2_statuses(is_in_tile_generation, dataset_id);
```

#### Add Tile Completion Tracking to `v2_statuses`

```sql
ALTER TABLE v2_statuses
ADD COLUMN has_ml_tiles BOOLEAN DEFAULT FALSE,
ADD COLUMN ml_tiles_completed_at TIMESTAMPTZ;
```

### TypeScript Types

**New file: `src/types/mlTiles.ts`**

```typescript
export type TileResolution = 5 | 10 | 20;

export type TileStatus = "pending" | "good" | "bad";

export interface IMLTile {
  id: number;
  dataset_id: number;
  user_id: string;
  resolution_cm: TileResolution;
  geometry: GeoJSON.Polygon; // In EPSG:3857
  parent_tile_id: number | null;
  status: TileStatus;
  tile_index: string;

  // Bounding box for export
  bbox_minx: number;
  bbox_miny: number;
  bbox_maxx: number;
  bbox_maxy: number;

  // Coverage statistics
  aoi_coverage_percent: number | null;
  deadwood_prediction_coverage_percent: number | null;
  forest_cover_prediction_coverage_percent: number | null;

  created_at: string;
  updated_at: string;
}

export interface ITileSession {
  dataset_id: number;
  is_locked: boolean;
  locked_by: string | null;
  locked_at: string | null;
}

export interface ITileGenerationProgress {
  dataset_id: number;
  total_20cm: number;
  completed_20cm: number;
  total_10cm: number;
  good_10cm: number;
  bad_10cm: number;
  pending_10cm: number;
  total_5cm: number;
  good_5cm: number;
  bad_5cm: number;
  pending_5cm: number;
}
```

### API Hooks

**New file: `src/hooks/useMLTiles.ts`**

```typescript
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "./useSupabase";
import { useAuth } from "./useAuthProvider";
import { IMLTile, TileResolution, TileStatus, ITileSession, ITileGenerationProgress } from "../types/mlTiles";

// Fetch all tiles for a dataset
export function useMLTiles(datasetId: number | undefined, resolution?: TileResolution) {
  return useQuery({
    queryKey: ["ml-tiles", datasetId, resolution],
    queryFn: async (): Promise<IMLTile[]> => {
      if (!datasetId) return [];

      let query = supabase.from("ml_training_tiles").select("*").eq("dataset_id", datasetId);

      if (resolution) {
        query = query.eq("resolution_cm", resolution);
      }

      const { data, error } = await query.order("tile_index");

      if (error) throw error;
      return data || [];
    },
    enabled: !!datasetId,
  });
}

// Fetch tiles by parent
export function useNestedTiles(parentTileId: number | undefined) {
  return useQuery({
    queryKey: ["ml-tiles", "nested", parentTileId],
    queryFn: async (): Promise<IMLTile[]> => {
      if (!parentTileId) return [];

      const { data, error } = await supabase
        .from("ml_training_tiles")
        .select("*")
        .eq("parent_tile_id", parentTileId)
        .order("tile_index");

      if (error) throw error;
      return data || [];
    },
    enabled: !!parentTileId,
  });
}

// Check session lock
export function useTileSessionLock(datasetId: number | undefined) {
  return useQuery({
    queryKey: ["tile-session-lock", datasetId],
    queryFn: async (): Promise<ITileSession | null> => {
      if (!datasetId) return null;

      const { data, error } = await supabase
        .from("v2_statuses")
        .select("is_in_tile_generation, tile_generation_locked_by, tile_generation_locked_at")
        .eq("dataset_id", datasetId)
        .single();

      if (error) throw error;

      return {
        dataset_id: datasetId,
        is_locked: data.is_in_tile_generation || false,
        locked_by: data.tile_generation_locked_by || null,
        locked_at: data.tile_generation_locked_at || null,
      };
    },
    enabled: !!datasetId,
    refetchInterval: 10000, // Check every 10s
  });
}

// Set session lock
export function useSetTileSessionLock() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (datasetId: number) => {
      const { data, error } = await supabase
        .from("v2_statuses")
        .update({
          is_in_tile_generation: true,
          tile_generation_locked_by: user?.id,
          tile_generation_locked_at: new Date().toISOString(),
        })
        .eq("dataset_id", datasetId)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: (_, datasetId) => {
      queryClient.invalidateQueries({ queryKey: ["tile-session-lock", datasetId] });
    },
  });
}

// Clear session lock
export function useClearTileSessionLock() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (datasetId: number) => {
      const { data, error } = await supabase
        .from("v2_statuses")
        .update({
          is_in_tile_generation: false,
          tile_generation_locked_by: null,
          tile_generation_locked_at: null,
        })
        .eq("dataset_id", datasetId)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: (_, datasetId) => {
      queryClient.invalidateQueries({ queryKey: ["tile-session-lock", datasetId] });
    },
  });
}

// Create a new tile
export function useCreateMLTile() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (tile: Omit<IMLTile, "id" | "created_at" | "updated_at" | "user_id">) => {
      const { data, error } = await supabase
        .from("ml_training_tiles")
        .insert({
          ...tile,
          user_id: user?.id,
        })
        .select()
        .single();

      if (error) throw error;
      return data as IMLTile;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["ml-tiles", data.dataset_id] });
      queryClient.invalidateQueries({ queryKey: ["tile-progress", data.dataset_id] });
    },
  });
}

// Update tile status
export function useUpdateTileStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ tileId, status }: { tileId: number; status: TileStatus }) => {
      const { data, error } = await supabase
        .from("ml_training_tiles")
        .update({
          status,
          updated_at: new Date().toISOString(),
        })
        .eq("id", tileId)
        .select()
        .single();

      if (error) throw error;
      return data as IMLTile;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["ml-tiles", data.dataset_id] });
      queryClient.invalidateQueries({ queryKey: ["tile-progress", data.dataset_id] });
    },
  });
}

// Delete a tile (and its children via CASCADE)
export function useDeleteMLTile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ tileId, datasetId }: { tileId: number; datasetId: number }) => {
      const { error } = await supabase.from("ml_training_tiles").delete().eq("id", tileId);

      if (error) throw error;
      return datasetId;
    },
    onSuccess: (datasetId) => {
      queryClient.invalidateQueries({ queryKey: ["ml-tiles", datasetId] });
      queryClient.invalidateQueries({ queryKey: ["tile-progress", datasetId] });
    },
  });
}

// Generate nested tiles (10cm from 20cm, or 5cm from 10cm)
export function useGenerateNestedTiles() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (parentTile: IMLTile) => {
      // Calculate 4 nested tiles in 2x2 grid
      const childResolution = parentTile.resolution_cm === 20 ? 10 : 5;
      const childTiles: Omit<IMLTile, "id" | "created_at" | "updated_at" | "user_id">[] = [];

      const { bbox_minx, bbox_miny, bbox_maxx, bbox_maxy } = parentTile;
      const midX = (bbox_minx + bbox_maxx) / 2;
      const midY = (bbox_miny + bbox_maxy) / 2;

      const quadrants = [
        { minx: bbox_minx, miny: midY, maxx: midX, maxy: bbox_maxy, idx: 0 }, // Top-left
        { minx: midX, miny: midY, maxx: bbox_maxx, maxy: bbox_maxy, idx: 1 }, // Top-right
        { minx: bbox_minx, miny: bbox_miny, maxx: midX, maxy: midY, idx: 2 }, // Bottom-left
        { minx: midX, miny: bbox_miny, maxx: bbox_maxx, maxy: midY, idx: 3 }, // Bottom-right
      ];

      for (const quad of quadrants) {
        const geometry: GeoJSON.Polygon = {
          type: "Polygon",
          coordinates: [
            [
              [quad.minx, quad.miny],
              [quad.maxx, quad.miny],
              [quad.maxx, quad.maxy],
              [quad.minx, quad.maxy],
              [quad.minx, quad.miny],
            ],
          ],
        };

        childTiles.push({
          dataset_id: parentTile.dataset_id,
          resolution_cm: childResolution,
          geometry,
          parent_tile_id: parentTile.id,
          status: "pending",
          tile_index: `${parentTile.tile_index}_${quad.idx}`,
          bbox_minx: quad.minx,
          bbox_miny: quad.miny,
          bbox_maxx: quad.maxx,
          bbox_maxy: quad.maxy,
          aoi_coverage_percent: null,
          deadwood_prediction_coverage_percent: null,
          forest_cover_prediction_coverage_percent: null,
        });
      }

      const { data, error } = await supabase
        .from("ml_training_tiles")
        .insert(childTiles.map((t) => ({ ...t, user_id: user?.id })))
        .select();

      if (error) throw error;
      return data as IMLTile[];
    },
    onSuccess: (_, parentTile) => {
      queryClient.invalidateQueries({ queryKey: ["ml-tiles", parentTile.dataset_id] });
      queryClient.invalidateQueries({ queryKey: ["ml-tiles", "nested", parentTile.id] });
      queryClient.invalidateQueries({ queryKey: ["tile-progress", parentTile.dataset_id] });
    },
  });
}

// Get progress summary
export function useTileProgress(datasetId: number | undefined) {
  return useQuery({
    queryKey: ["tile-progress", datasetId],
    queryFn: async (): Promise<ITileGenerationProgress | null> => {
      if (!datasetId) return null;

      const { data, error } = await supabase
        .from("ml_training_tiles")
        .select("resolution_cm, status")
        .eq("dataset_id", datasetId);

      if (error) throw error;
      if (!data) return null;

      const tiles = data as Pick<IMLTile, "resolution_cm" | "status">[];

      const progress: ITileGenerationProgress = {
        dataset_id: datasetId,
        total_20cm: tiles.filter((t) => t.resolution_cm === 20).length,
        completed_20cm: tiles.filter((t) => t.resolution_cm === 20 && t.status !== "pending").length,
        total_10cm: tiles.filter((t) => t.resolution_cm === 10).length,
        good_10cm: tiles.filter((t) => t.resolution_cm === 10 && t.status === "good").length,
        bad_10cm: tiles.filter((t) => t.resolution_cm === 10 && t.status === "bad").length,
        pending_10cm: tiles.filter((t) => t.resolution_cm === 10 && t.status === "pending").length,
        total_5cm: tiles.filter((t) => t.resolution_cm === 5).length,
        good_5cm: tiles.filter((t) => t.resolution_cm === 5 && t.status === "good").length,
        bad_5cm: tiles.filter((t) => t.resolution_cm === 5 && t.status === "bad").length,
        pending_5cm: tiles.filter((t) => t.resolution_cm === 5 && t.status === "pending").length,
      };

      return progress;
    },
    enabled: !!datasetId,
  });
}

// Mark dataset as tile generation complete
export function useCompleteTileGeneration() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (datasetId: number) => {
      const { data, error } = await supabase
        .from("v2_statuses")
        .update({
          has_ml_tiles: true,
          ml_tiles_completed_at: new Date().toISOString(),
          is_in_tile_generation: false,
          tile_generation_locked_by: null,
          tile_generation_locked_at: null,
        })
        .eq("dataset_id", datasetId)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: (_, datasetId) => {
      queryClient.invalidateQueries({ queryKey: ["datasets"] });
      queryClient.invalidateQueries({ queryKey: ["tile-session-lock", datasetId] });
    },
  });
}
```

## UI Components

### 1. Updated Audit Tab Structure

**File: `src/pages/DatasetAudit.tsx`**

Update the `AuditFilter` type and tab structure:

```typescript
type AuditFilter =
  | "needs-audit"
  | "audited"
  | "needs-tiles"
  | "training-ready"
  | "fixable-issues"
  | "excluded"
  | "flagged";

// Tab options in Segmented component:
[
  { label: `Needs Audit (${needsAuditCount})`, value: "needs-audit" },
  { label: `Audited (${auditedCount})`, value: "audited" },
  { label: `Tiles Pending (${needsTilesCount})`, value: "needs-tiles" },
  { label: `Training Ready (${trainingReadyCount})`, value: "training-ready" },
  { label: `Fixable (${fixableIssuesCount})`, value: "fixable-issues" },
  { label: `Excluded (${excludedCount})`, value: "excluded" },
  { label: `Flagged (${flaggedCount})`, value: "flagged" },
];
```

Add button in "Audited" and "Needs Tiles" tabs:

```typescript
{
  title: "ML Tiles",
  key: "ml_tiles",
  render: (_: unknown, record: IDataset) => {
    const hasStartedTiles = /* check if tiles exist */;
    return (
      <Button
        size="small"
        onClick={() => navigate(`/dataset-audit/${record.id}/ml-tiles`)}
      >
        {hasStartedTiles ? "Continue Tiles" : "Generate ML Tiles"}
      </Button>
    );
  },
  width: 130,
}
```

### 2. ML Tile Editor Page

**New file: `src/pages/DatasetMLTiles.tsx`**

Main container for the tile generation workflow.

```typescript
import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button, Space, message, Modal } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { useDatasets } from '../hooks/useDatasets';
import { useMLTiles, useTileSessionLock, useSetTileSessionLock, useClearTileSessionLock } from '../hooks/useMLTiles';
import { useAuth } from '../hooks/useAuthProvider';
import MLTileMap from '../components/MLTiles/MLTileMap';
import MLTilePhaseManager from '../components/MLTiles/MLTilePhaseManager';

export default function DatasetMLTiles() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: datasets } = useDatasets();
  const dataset = datasets?.find(d => d.id.toString() === id);

  const { data: sessionLock } = useTileSessionLock(dataset?.id);
  const { mutateAsync: setLock } = useSetTileSessionLock();
  const { mutateAsync: clearLock } = useClearTileSessionLock();

  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  // Acquire lock on mount
  useEffect(() => {
    if (!dataset || !user) return;

    if (sessionLock?.is_locked && sessionLock.locked_by !== user.id) {
      message.error('Another user is currently editing tiles for this dataset');
      navigate('/dataset-audit');
      return;
    }

    setLock(dataset.id).catch(err => {
      console.error('Failed to acquire lock:', err);
      message.error('Could not start tile generation session');
      navigate('/dataset-audit');
    });

    return () => {
      if (dataset?.id) {
        clearLock(dataset.id);
      }
    };
  }, [dataset?.id, user?.id, sessionLock]);

  // Handle navigation away with unsaved changes
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = '';
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedChanges]);

  const handleBack = () => {
    if (hasUnsavedChanges) {
      Modal.confirm({
        title: 'Unsaved Changes',
        content: 'You have unsaved changes. Are you sure you want to leave?',
        okText: 'Leave',
        cancelText: 'Stay',
        onOk: () => {
          if (dataset?.id) {
            clearLock(dataset.id);
          }
          navigate(-1);
        },
      });
    } else {
      if (dataset?.id) {
        clearLock(dataset.id);
      }
      navigate(-1);
    }
  };

  if (!dataset) {
    return <div className="p-6">Loading dataset...</div>;
  }

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center justify-between border-b p-4">
        <div className="flex items-center gap-3">
          <Button icon={<ArrowLeftOutlined />} onClick={handleBack} />
          <div>
            <div className="text-lg font-semibold">ML Training Tiles</div>
            <div className="text-sm text-gray-500">Dataset {dataset.id}</div>
          </div>
        </div>
      </div>

      <MLTilePhaseManager
        dataset={dataset}
        onUnsavedChanges={setHasUnsavedChanges}
      />
    </div>
  );
}
```

### 3. Phase Manager Component

**New file: `src/components/MLTiles/MLTilePhaseManager.tsx`**

Manages the three phases of tile generation.

```typescript
import { useState, useMemo } from 'react';
import { Tabs, Button, Space, Statistic, Card, Progress, message } from 'antd';
import { IDataset } from '../../types/dataset';
import { useMLTiles, useTileProgress, useCompleteTileGeneration } from '../../hooks/useMLTiles';
import MLTilePlacementPhase from './MLTilePlacementPhase';
import MLTileQAPhase from './MLTileQAPhase';
import MLTileValidationPhase from './MLTileValidationPhase';

interface Props {
  dataset: IDataset;
  onUnsavedChanges: (hasChanges: boolean) => void;
}

export default function MLTilePhaseManager({ dataset, onUnsavedChanges }: Props) {
  const [activePhase, setActivePhase] = useState<'placement' | 'qa' | 'validation'>('placement');
  const { data: tiles20cm } = useMLTiles(dataset.id, 20);
  const { data: progress } = useTileProgress(dataset.id);
  const { mutateAsync: completeGeneration, isPending: isCompleting } = useCompleteTileGeneration();

  const has20cmTiles = (tiles20cm?.length || 0) > 0;
  const has10cmPending = (progress?.pending_10cm || 0) > 0;
  const has5cmPending = (progress?.pending_5cm || 0) > 0;

  // Calculate overall completion percentage
  const totalTiles = (progress?.total_10cm || 0) + (progress?.total_5cm || 0);
  const completedTiles =
    (progress?.good_10cm || 0) + (progress?.bad_10cm || 0) +
    (progress?.good_5cm || 0) + (progress?.bad_5cm || 0);
  const completionPercent = totalTiles > 0 ? Math.round((completedTiles / totalTiles) * 100) : 0;

  const canMoveToQA = has20cmTiles && (has10cmPending || has5cmPending);
  const canMoveToValidation = completionPercent > 0;

  const handleComplete = async () => {
    try {
      await completeGeneration(dataset.id);
      message.success('Dataset marked as Training Ready');
      // Navigate back or show success state
    } catch (err) {
      message.error('Failed to complete tile generation');
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Progress Summary */}
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
            <div className="text-sm text-gray-500 mb-1">Overall Progress</div>
            <Progress percent={completionPercent} style={{ width: 200 }} />
          </div>
          {completionPercent === 100 && (
            <Button
              type="primary"
              size="large"
              onClick={handleComplete}
              loading={isCompleting}
            >
              Mark as Training Ready
            </Button>
          )}
        </Space>
      </div>

      {/* Phase Tabs */}
      <Tabs
        activeKey={activePhase}
        onChange={(key) => setActivePhase(key as any)}
        className="flex-1"
        items={[
          {
            key: 'placement',
            label: 'Phase 1: Place 20cm Tiles',
            children: (
              <MLTilePlacementPhase
                dataset={dataset}
                onUnsavedChanges={onUnsavedChanges}
                onComplete={() => {
                  if (canMoveToQA) setActivePhase('qa');
                }}
              />
            ),
          },
          {
            key: 'qa',
            label: 'Phase 2: QA Tiles',
            disabled: !has20cmTiles,
            children: (
              <MLTileQAPhase
                dataset={dataset}
                onUnsavedChanges={onUnsavedChanges}
              />
            ),
          },
          {
            key: 'validation',
            label: 'Phase 3: Validate & Review',
            disabled: !canMoveToValidation,
            children: (
              <MLTileValidationPhase
                dataset={dataset}
              />
            ),
          },
        ]}
      />
    </div>
  );
}
```

## Implementation Stages

### Stage 0: Database & Types Setup

**Tasks:**

- [ ] Create database migration for `ml_training_tiles` table
- [ ] Add session tracking columns to `v2_statuses`
- [ ] Create TypeScript types in `src/types/mlTiles.ts`
- [ ] Add RLS policies for table

**Time estimate:** 2-3 hours

### Stage 1: Core Hooks & API

**Tasks:**

- [ ] Implement `useMLTiles` hooks in `src/hooks/useMLTiles.ts`
- [ ] Implement session locking hooks
- [ ] Implement tile CRUD mutations
- [ ] Add tile progress tracking hook

**Time estimate:** 4-6 hours

### Stage 2: Phase 1 - Tile Placement UI

**Tasks:**

- [ ] Create `MLTilePlacementPhase` component
- [ ] Implement map with draggable tile rectangles
- [ ] Add layer toggles (AOI, Deadwood, Forest Cover)
- [ ] Implement tile validation (no overlap, 60% AOI coverage)
- [ ] Add tile creation/deletion
- [ ] Lock tile rectangle size to target GSD (fixed 204.8m @20cm; 102.4m @10cm; 51.2m @5cm); allow translate only (no scale/rotate)
- [ ] Save tiles to database

**Components:**

- `src/components/MLTiles/MLTilePlacementPhase.tsx`
- `src/components/MLTiles/MLTileMap.tsx`
- `src/components/MLTiles/DraggableTile.tsx`

**Time estimate:** 8-10 hours

### Stage 3: Phase 2 - QA Workflow

**Tasks:**

- [ ] Create `MLTileQAPhase` component
- [ ] Implement sequential tile zoom interface
- [ ] Add Good/Bad buttons with keyboard shortcuts (G/B/arrows)
- [ ] Generate nested 10cm tiles from 20cm
- [ ] Generate nested 5cm tiles from good 10cm tiles
- [ ] Progress tracking per parent tile

**Components:**

- `src/components/MLTiles/MLTileQAPhase.tsx`
- `src/components/MLTiles/TileQAModal.tsx`

**Time estimate:** 6-8 hours

### Stage 4: Phase 3 - Validation UI

**Tasks:**

- [ ] Create `MLTileValidationPhase` component
- [ ] Show all tiles on map with color-coded status
- [ ] Allow clicking tiles to change status
- [ ] Filter by resolution and status
- [ ] Summary statistics

**Components:**

- `src/components/MLTiles/MLTileValidationPhase.tsx`

**Time estimate:** 4-6 hours

### Stage 5: Audit Integration

**Tasks:**

- [ ] Update `DatasetAudit.tsx` with new tabs
- [ ] Add "Generate ML Tiles" button
- [ ] Update filter logic for tile status
- [ ] Add progress counts to tab badges
- [ ] Route to `/dataset-audit/:id/ml-tiles`

**Time estimate:** 3-4 hours

### Stage 6: Polish & Testing

**Tasks:**

- [ ] Add loading states
- [ ] Error handling & user feedback
- [ ] Session lock warnings
- [ ] Unsaved changes modal
- [ ] Keyboard shortcuts documentation
- [ ] Mobile responsiveness checks
- [ ] Integration testing

**Time estimate:** 4-6 hours

### Stage 7: Documentation

**Tasks:**

- [ ] Update README with ML Tiles feature
- [ ] Add user guide for auditors
- [ ] Document export data format
- [ ] Create SQL queries for export script

**Time estimate:** 2-3 hours

## Total Time Estimate

**Core Implementation:** 35-45 hours
**With buffer (15%):** 40-52 hours

## Technical Considerations

### Tile Geometry Calculations

For 1024×1024 pixel tiles at different GSD:

- **20cm GSD**: 1024 \* 0.20m = 204.8m × 204.8m ground area
- **10cm GSD**: 1024 \* 0.10m = 102.4m × 102.4m ground area
- **5cm GSD**: 1024 \* 0.05m = 51.2m × 51.2m ground area

Store bounding boxes in EPSG:3857 (Web Mercator) for consistency with existing map system.

### AOI Coverage Calculation

Calculate percentage of tile area within AOI polygon:

1. Use Turf.js `intersect()` to get overlap polygon
2. Calculate area of overlap vs tile area
3. Must be ≥ 60% to be valid

**Install dependency:**

```bash
npm install @turf/turf
```

## Exporter Spec (Short)

### Approach

- Keep everything in EPSG:3857 (COGs and stored tile bboxes are already in 3857).
- Fix output size to exactly 1024×1024 pixels.
- Define each tile bbox so that bbox width/height = 1024 × target_gsd_m (0.20 / 0.10 / 0.05 m/px).
- During export, crop by bbox and resample to 1024×1024; assert effective GSD: `(bbox_width_m / 1024)` equals the target within a small tolerance.
- Reject tiles that extend outside the COG extent; do not pad with nodata in MVP.
- Note: EPSG:3857 meters are projected; if strict ground‑meter accuracy is required later, warp to a local equal‑distance CRS (e.g., UTM) before the same crop/resample.

### Inputs

- `v2_cogs.cog_path` (COG URL/path), `v2_cogs.cog_info.GEO.BoundingBox` (sanity checks)
- `ml_training_tiles` row: `dataset_id`, `tile_index`, `resolution_cm`, `bbox_minx/bbox_miny/bbox_maxx/bbox_maxy`
- Optional: coverage stats for sidecar JSON

### Output

- PNG image: 1024×1024 pixels
- JSON sidecar with: `dataset_id`, `tile_index`, `resolution_cm`, `bbox_3857`, `eff_gsd_m`, `source_resolution_m_px` (from `cog_info.GEO.Resolution[0]`), and coverage stats
- Suggested filename: `${dataset_id}_${tile_index}_${resolution_cm}cm.png`

### GDAL CLI (no reprojection)

```bash
gdal_translate \
  -projwin_srs EPSG:3857 \
  -projwin MINX MAXY MAXX MINY \
  -outsize 1024 1024 \
  -r bilinear \
  -of PNG \
  input_cog.tif output.png
```

### Python (rasterio) reference

```python
import json, numpy as np, rasterio
from rasterio.windows import from_bounds
from rasterio.enums import Resampling
from imageio.v3 import imwrite

def export_tile_png(cog_path, bbox, target_gsd_m, out_png, meta):
    minx, miny, maxx, maxy = bbox
    eff_gsd_m = (maxx - minx) / 1024.0
    assert abs(eff_gsd_m - target_gsd_m) < 1e-6
    with rasterio.open(cog_path) as src:
        # bounds check against src.bounds; raise if outside
        win = from_bounds(minx, maxy, maxx, miny, src.transform)
        data = src.read(indexes=(1,2,3), window=win, out_shape=(3,1024,1024), resampling=Resampling.bilinear)
    imwrite(out_png, np.moveaxis(data, 0, -1))
    with open(out_png.replace('.png','.json'), 'w') as f:
        json.dump({**meta, 'eff_gsd_m': eff_gsd_m}, f)
```

### Validation Checklist (export‑time)

- PNG shape is exactly 1024×1024
- `eff_gsd_m = (bbox_width_m / 1024)` equals target (within tolerance)
- Tile bbox fully inside COG extent (`cog_info.GEO.BoundingBox`)
- AOI coverage ≥ 60% (prevalidated in UI; can be re‑checked server‑side if needed)
- No tile overlap (ensured in UI; exporter can enforce by unique `tile_index`)

### Prediction Coverage Calculation

For deadwood/forest cover statistics:

1. Query MVT tiles for features within tile bounds
2. Calculate total prediction polygon area within tile
3. Express as percentage of tile area

This can be computed on-demand or pre-calculated when tile is created.

### Drag & Drop Implementation

Use OpenLayers `Translate` interaction for dragging tiles:

```typescript
import { Translate } from "ol/interaction";

const translate = new Translate({
  layers: [tileLayer],
});

translate.on("translateend", (evt) => {
  // Validate new position
  // Update tile geometry in state
});
```

### Keyboard Shortcuts

Implement in QA phase using `useEffect` with event listeners:

```typescript
useEffect(() => {
  const handleKeyPress = (e: KeyboardEvent) => {
    if (e.key === "g" || e.key === "G") markCurrentTile("good");
    if (e.key === "b" || e.key === "B") markCurrentTile("bad");
    if (e.key === "ArrowRight") moveToNextTile();
    if (e.key === "ArrowLeft") moveToPreviousTile();
    if (e.key === " ") skipCurrentTile();
    if (e.key === "Escape") exitQAMode();
  };

  window.addEventListener("keydown", handleKeyPress);
  return () => window.removeEventListener("keydown", handleKeyPress);
}, [currentTileIndex]);
```

## Future Enhancements (Out of Scope for MVP)

- [ ] Batch export script (Python) to generate PNGs from tiles
- [ ] Prediction-guided auto-placement
- [ ] Tile overlap detection visualization
- [ ] Multi-dataset tile generation
- [ ] Export format customization (resolution, format)
- [ ] Tile annotation/notes
- [ ] Statistics dashboard for all tile generations
- [ ] ML model integration for quality suggestions

## Testing Strategy

### Unit Tests

- Tile geometry calculations
- AOI coverage validation
- Nested tile generation logic

### Integration Tests

- Full workflow: Placement → QA → Validation
- Session locking behavior
- Unsaved changes handling

### Manual QA Checklist

- [ ] Create 20cm tiles without overlap
- [ ] Validate 60% AOI coverage requirement
- [ ] QA workflow with keyboard shortcuts
- [ ] Change tile status in validation phase
- [ ] Progress tracking updates correctly
- [ ] Session lock prevents concurrent edits
- [ ] Unsaved changes warning on navigation

## Success Criteria

- ✅ Auditor can place 1-10 tiles for a dataset in < 5 minutes
- ✅ QA workflow supports reviewing 50+ tiles in < 10 minutes
- ✅ All tile geometries stored with required metadata
- ✅ Progress tracking shows real-time completion status
- ✅ Export-ready data structure in database
- ✅ No data loss from concurrent access
- ✅ Responsive UI for standard screen sizes (1920×1080+)

## Migration Path

### Database Migration Order

1. Create `ml_training_tiles` table
2. Add columns to `v2_statuses`
3. Create indexes
4. Enable RLS policies

### Rollback Plan

If issues arise, the feature is fully isolated:

- Drop `ml_training_tiles` table
- Remove columns from `v2_statuses`
- No impact on existing audit workflow

---

## Next Steps

1. **Review & Approval**: Get stakeholder sign-off on this plan
2. **Create GitHub Issues**: Break down into trackable tasks
3. **Database Migration**: Create and test SQL migration script
4. **Begin Stage 0**: Set up database schema and TypeScript types
5. **Iterate**: Implement stages 1-7 sequentially with testing between each

---

**Document Version:** 1.0
**Created:** 2025-10-06
**Author:** AI Assistant
**Status:** Draft - Awaiting Review
