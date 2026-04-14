# Phenology Visualization Frontend Implementation Plan

## Overview

This document outlines the implementation plan for displaying phenology information as a visual bar component in the DeadTrees.earth frontend. The visualization will show growing season patterns with acquisition date markers, using data-driven color gradients from MODIS phenology data.

## Backend Data Structure

### Database Schema

- **Table**: `v2_metadata`
- **Structure**:
  ```sql
  dataset_id (bigint, PK, FK to v2_datasets)
  metadata (jsonb) -- Contains phenology data
  version (integer)
  created_at (timestamp with time zone)
  processing_runtime (double precision)
  ```

### Phenology Data Format

```json
{
  "phenology": {
    "phenology_curve": [0, 5, 10, ..., 255], // 366 integer values (0-255)
    "source": "MODIS Phenology",
    "version": "1.0"
  }
}
```

## Frontend Implementation

### 1. TypeScript Interfaces

**File**: `src/types/phenology.ts`

```typescript
export interface PhenologyMetadata {
  phenology_curve: number[]; // 366 values, 0-255 range
  source: string;
  version: string;
}

export interface DatasetMetadata {
  gadm?: AdminBoundariesMetadata;
  biome?: BiomeMetadata;
  phenology?: PhenologyMetadata;
}
```

### 2. Utility Functions

**File**: `src/utils/phenologyUtils.ts`

#### Core Functions:

- `calculateDayOfYear(year, month?, day?)` - Handle different date granularities
- `generatePhenologyGradient(phenologyCurve)` - Convert 0-255 values to color gradient
- `formatPhenologyTooltip(dayOfYear, phenologyValue)` - Generate tooltip content
- `getAcquisitionPeriod(year, month?, day?)` - Calculate acquisition period visualization

#### Color Mapping Logic:

- **Values 0-50**: Browns/dormant colors (`#8B4513` to `#D2B48C`)
- **Values 51-150**: Greens/growing season (`#90EE90` to `#228B22`)
- **Values 151-255**: Peak greens (`#006400` to `#32CD32`)

### 3. React Hook for Phenology Data

**File**: `src/hooks/usePhenologyData.ts`

```typescript
export function usePhenologyData(datasetId: number | undefined) {
  return useQuery({
    queryKey: ["phenology-data", datasetId],
    queryFn: async () => {
      if (!datasetId) return null;

      const { data, error } = await supabase
        .from("v2_metadata")
        .select("metadata")
        .eq("dataset_id", datasetId)
        .single();

      if (error || !data?.metadata?.phenology) {
        return null;
      }

      return data.metadata.phenology as PhenologyMetadata;
    },
    enabled: !!datasetId,
  });
}
```

### 4. PhenologyBar Component

**File**: `src/components/PhenologyBar/PhenologyBar.tsx`

#### Component Features:

- **Horizontal bar**: 366-day timeline representation
- **Data-driven gradient**: Colors based on phenology_curve values
- **Acquisition marker**: Red arrow indicating acquisition date
- **Responsive design**: Adapts to container width
- **Accessibility**: ARIA labels and keyboard navigation
- **Tooltips**: Hover information for phenology values

#### Props Interface:

```typescript
interface PhenologyBarProps {
  phenologyData?: PhenologyMetadata;
  acquisitionYear: string | number;
  acquisitionMonth?: string | number;
  acquisitionDay?: string | number;
  className?: string;
  showTooltips?: boolean;
}
```

#### Key Implementation Details:

1. **Gradient Generation**:

   - Map 366 phenology values to CSS gradient stops
   - Use linear interpolation for smooth transitions
   - Cache calculated gradients for performance

2. **Acquisition Date Handling**:

   - **Full date**: Single arrow marker at specific day
   - **Month only**: Highlighted month range (approx 30-day span)
   - **Year only**: Entire bar highlighted with different opacity

3. **Visual Design**:
   - Rounded bar (`rounded-md`) consistent with app design
   - Height: 16px (similar to existing progress bars)
   - Width: 100% of container
   - Drop shadow for depth

### 5. Integration Points

#### 5.1 DatasetAuditDetail.tsx Integration

**Location**: Step 3 - Phenology section

```typescript
// Add after biome information display
{dataset.biome_name && (
  <div className="mb-2 rounded bg-green-50 p-2">
    <Text className="text-xs font-medium text-green-800">🌿 Biome: {dataset.biome_name}</Text>
  </div>
)}

{/* NEW: Phenology Bar */}
<PhenologyBar
  phenologyData={phenologyData}
  acquisitionYear={dataset.aquisition_year}
  acquisitionMonth={dataset.aquisition_month}
  acquisitionDay={dataset.aquisition_day}
  className="mb-2"
  showTooltips={true}
/>
```

#### 5.2 DatasetDetails.tsx Integration

**Location**: Acquisition Date section in sidebar

```typescript
<div className="flex justify-between">
  <Typography.Text className="pr-2">Acquisition Date: </Typography.Text>
  <div className="flex flex-col items-end">
    <Typography.Text strong>
      {formatAcquisitionDate()}
    </Typography.Text>
    {/* NEW: Phenology Bar */}
    <div className="mt-1 w-full max-w-[200px]">
      <PhenologyBar
        phenologyData={phenologyData}
        acquisitionYear={dataset.aquisition_year}
        acquisitionMonth={dataset.aquisition_month}
        acquisitionDay={dataset.aquisition_day}
        showTooltips={true}
      />
    </div>
  </div>
</div>
```

### 6. Tooltip Implementation

**Features**:

- **Hover activation**: Show phenology value and day information
- **Content**: "Day 150: Peak growing season (Value: 180/255)"
- **Positioning**: Smart positioning to avoid viewport edges
- **Styling**: Consistent with Ant Design tooltip theme

### 7. Error Handling & Loading States

#### Loading State:

```typescript
{isPhenologyLoading ? (
  <div className="h-4 w-full animate-pulse rounded bg-gray-200" />
) : phenologyData ? (
  <PhenologyBar {...props} />
) : (
  <div className="text-xs text-gray-500">Phenology data not available</div>
)}
```

#### Error Scenarios:

- **No phenology data**: Show placeholder message
- **Invalid data**: Log error, show fallback visualization
- **Network errors**: Retry mechanism with exponential backoff

### 8. Performance Considerations

#### Optimization Strategies:

1. **Memoization**: Use `useMemo` for gradient calculations
2. **Lazy loading**: Only fetch phenology data when component is visible
3. **Caching**: Cache phenology data in React Query with 1-hour TTL
4. **Debounced tooltips**: Prevent excessive re-renders on hover

### 11. Development Phases

#### Phase 1: Core Implementation

- [ ] Create TypeScript interfaces
- [ ] Implement utility functions
- [ ] Build basic PhenologyBar component
- [ ] Add database query hook

#### Phase 2: Integration

- [ ] Integrate into DatasetAuditDetail.tsx
- [ ] Integrate into DatasetDetails.tsx
- [ ] Implement tooltip functionality
- [ ] Add loading and error states

### 13. Dependencies

#### New Dependencies: None

- Uses existing Ant Design components
- Leverages current Supabase/React Query setup
- Built with existing Tailwind CSS classes

#### Required Updates:

- Update `src/types/dataset.ts` to include metadata field
- Add phenology data fetching to existing hooks

### Frontend Development

- [ ] Create TypeScript interfaces
- [ ] Implement utility functions with tests
- [ ] Build PhenologyBar component
- [ ] Add database integration hook
- [ ] Integrate into DatasetAuditDetail.tsx
- [ ] Integrate into DatasetDetails.tsx

_This implementation plan follows the established project patterns and maintains consistency with the existing codebase architecture._
