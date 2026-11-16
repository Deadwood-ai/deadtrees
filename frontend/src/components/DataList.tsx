import { memo, useMemo, useState } from "react";
import ListItem from "./ListItem";
import { Button } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import EmptyStatePanel from "./EmptyStatePanel";
import { IDataset, IDatasetArchiveItem } from "../types/dataset";
import type { ArchiveChipFilter } from "../utils/datasetArchiveFilters";
import type { InfoSnippet } from "../utils/archiveTextSearch";

type ListDataset = IDataset | IDatasetArchiveItem;

interface DataListProps {
  data: ListDataset[];
  hoveredItem: number | null;
  setHoveredItem: (id: number | null) => void;
  visibleFeatures: string[];
  onFilterClick: (key: ArchiveChipFilter, value: string) => void;
  filterByViewport: boolean;
  // Frames every match on the map when the current view hides them all.
  onZoomToMatches?: () => void;
  // The matched part of a dataset's additional information, when it matched.
  findInfoSnippet?: (datasetId: number) => InfoSnippet | null;
  scores?: Map<number, number> | null;
  semanticQuery?: string | null;
}

function DataList({
  data,
  hoveredItem,
  setHoveredItem,
  visibleFeatures,
  onFilterClick,
  filterByViewport,
  onZoomToMatches,
  findInfoSnippet,
  scores,
  semanticQuery,
}: DataListProps) {
  const [nItems, setNItems] = useState(50);

  // "Filter list by map view" narrows every result, searches included, so a
  // visitor can look for one author's or one query's datasets in a region.
  //
  // Both lists hold every dataset in the archive (~7.5k), so a linear scan of
  // visibleFeatures per item is quadratic and blocks the main thread for ~90ms
  // on each render — which is every keystroke, pan and hover. A Set lookup keeps
  // this at ~1.5ms.
  const visibleData = useMemo(() => {
    if (!filterByViewport) return data;
    const visibleIds = new Set(visibleFeatures);
    return data.filter((item) => visibleIds.has(item.id.toString()));
  }, [data, visibleFeatures, filterByViewport]);
  const hiddenByMap = data.length - visibleData.length;

  const handleMoreItems = () => {
    setNItems(nItems + 50);
  };

  return (
    <div className="flex-1 space-y-1.5 overflow-y-auto pr-1 md:space-y-2">
      {visibleData.length === 0 && hiddenByMap > 0 ? (
        <EmptyStatePanel
          testId="dataset-empty-results"
          icon={<SearchOutlined />}
          title="No matches in this map view"
          description={`${hiddenByMap} ${hiddenByMap === 1 ? "image matches" : "images match"} elsewhere.`}
          action={
            onZoomToMatches && (
              <Button onClick={onZoomToMatches} data-testid="dataset-zoom-to-matches">
                Show on map
              </Button>
            )
          }
        />
      ) : visibleData.length === 0 ? (
        <EmptyStatePanel
          testId="dataset-empty-results"
          icon={<SearchOutlined />}
          title="No drone images match"
          description="Clear a filter or change the search to see more."
        />
      ) : (
        <>
          {visibleData
            .slice(0, nItems)
            .map(
              (item, index) =>
                item.id && (
                  <ListItem
                    key={index}
                    item={item}
                    index={index}
                    isHovered={hoveredItem === item.id}
                    setHoveredItem={setHoveredItem}
                    onFilterClick={onFilterClick}
                    score={scores?.get(item.id) ?? null}
                    infoSnippet={findInfoSnippet?.(item.id) ?? null}
                    semanticQuery={semanticQuery ?? null}
                  />
                ),
            )}
          {visibleData.length > nItems && (
            <div className="flex justify-center pb-4 pt-2">
              <Button onClick={handleMoreItems} type="default">
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default memo(DataList);
