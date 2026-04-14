import { useState } from "react";
import ListItem from "./ListItem";
import { Button } from "antd";
import { IDataset } from "../types/dataset";

interface DataListProps {
  data: IDataset[];
  hoveredItem: number | null;
  setHoveredItem: (id: number | null) => void;
  visibleFeatures: string[];
  onFilterClick: (
    filterValue: string,
    filterType: "platform" | "license" | "authors_image" | "admin_level_1" | "admin_level_3" | "biome",
  ) => void;
  searchValue: string;
  filterByViewport: boolean;
}

export default function DataList({
  data,
  hoveredItem,
  setHoveredItem,
  visibleFeatures,
  onFilterClick,
  searchValue,
  filterByViewport,
}: DataListProps) {
  const [nItems, setNItems] = useState(50);

  // Filter data by visible features in the map viewport only when:
  // 1. Not searching
  // 2. Viewport filtering is enabled
  const visibleData =
    !searchValue && filterByViewport ? data.filter((item) => visibleFeatures.includes(item.id.toString())) : data;

  const handleMoreItems = () => {
    setNItems(nItems + 50);
  };

  return (
    <div className="flex-1 space-y-1.5 overflow-y-auto pr-1 md:space-y-2">
      {!visibleData ? (
        <div>Loading...</div>
      ) : visibleData.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center">
          <div className="text-lg font-medium text-gray-500">No results found</div>
          <div className="text-sm text-gray-400">Try adjusting your filters or search criteria</div>
        </div>
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
                    hoveredItem={hoveredItem}
                    setHoveredItem={setHoveredItem}
                    onFilterClick={onFilterClick}
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
