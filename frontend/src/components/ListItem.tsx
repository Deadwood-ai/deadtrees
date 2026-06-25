import { Button, Tag, Tooltip } from "antd";
import { useNavigate } from "react-router-dom";
import { IDataAccess, IDataset, IDatasetArchiveItem } from "../types/dataset";
import { Settings } from "../config";
import countryList from "../utils/countryList";
import { useDatasetDetailsMap } from "../hooks/useDatasetDetailsMapProvider";
import {
  getBiomeEmoji,
  getBiomeTagColor,
  truncateBiomeLabel,
} from "../utils/biomeDisplay";

interface ListItemProps {
  item: IDataset | IDatasetArchiveItem;
  index: number;
  setHoveredItem: ((id: number | null) => void) | undefined;
  hoveredItem: number | null;
  onFilterClick: (
    filterValue: string,
    filterType:
      | "platform"
      | "license"
      | "authors_image"
      | "admin_level_1"
      | "admin_level_3"
      | "biome",
  ) => void;
  // Open-vocabulary search relevance (0..1) when a semantic query is active.
  score?: number | null;
  // Active semantic query, forwarded to the details page to highlight tiles.
  semanticQuery?: string | null;
}

const ListItem = ({
  item,
  index,
  setHoveredItem,
  hoveredItem,
  onFilterClick,
  score,
  semanticQuery,
}: ListItemProps) => {
  const navigate = useNavigate();
  const { setNavigationSource } = useDatasetDetailsMap();

  // Forward the active query so the details page can highlight matching tiles.
  const datasetUrl = semanticQuery
    ? `/dataset/${item.id}?q=${encodeURIComponent(semanticQuery)}`
    : `/dataset/${item.id}`;

  const handleMouseEnter = () => {
    if (setHoveredItem) {
      setHoveredItem(item.id);
    }
  };

  const handleMouseLeave = () => {
    if (setHoveredItem) {
      setHoveredItem(null);
    }
  };

  const openInNewTab = () => {
    window.open(datasetUrl, "_blank", "noopener,noreferrer");
  };

  const onClickHandler = (e: React.MouseEvent) => {
    // Ctrl/Cmd-click opens in a new tab, like a normal link.
    if (e.ctrlKey || e.metaKey) {
      openInNewTab();
      return;
    }
    setNavigationSource("dataset");
    navigate(datasetUrl);
  };

  // Middle-click (or any auxiliary button) opens the dataset in a new tab.
  const onAuxClickHandler = (e: React.MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault();
      openInNewTab();
    }
  };

  const onClickFilterHandler = (
    e: React.MouseEvent,
    filter: string,
    filterType:
      | "platform"
      | "license"
      | "authors_image"
      | "admin_level_1"
      | "admin_level_3"
      | "biome",
  ) => {
    onFilterClick(filter, filterType);
    e.stopPropagation();
  };

  const adminLevel3 = item.admin_level_3 || item.admin_level_2 || "";
  const adminLevel1 = item.admin_level_1 || "";
  const firstAuthor = item.authors?.[0] || "";
  const truncatedFirstAuthor = firstAuthor
    ? firstAuthor.slice(0, 16) + (firstAuthor.length > 16 ? "..." : "")
    : "";
  const biomeName = item.biome_name;
  const biomeLabel = biomeName || "Unknown";
  const biomeColor = getBiomeTagColor(biomeName);
  const biomeIcon = getBiomeEmoji(biomeName);
  const isPrivate = item.data_access === IDataAccess.private;

  return (
    <div
      key={index}
      data-testid="dataset-list-item"
      className={`flex rounded-md p-2 transition duration-150 ease-in-out ${
        hoveredItem === item.id ? "bg-gray-200" : "bg-white hover:bg-gray-100"
      }`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={onClickHandler}
      onAuxClick={onAuxClickHandler}
    >
      <div className="relative h-16 w-16 min-h-16 min-w-16 shrink-0 overflow-hidden rounded-lg">
        <img
          src={
            item.thumbnail_path
              ? Settings.THUMBNAIL_URL + item.thumbnail_path
              : "/assets/tree-icon.png"
          }
          className="m-0 h-full w-full scale-150 object-cover transition-transform hover:z-10"
          loading="lazy"
        />
      </div>
      <div className="flex flex-1 flex-col justify-between pl-3 min-w-0">
        <div className="flex justify-between items-start gap-1">
          <div className="flex items-baseline min-w-0 flex-1 truncate">
            <Tooltip title={adminLevel3}>
              <Button
                type="text"
                size="small"
                className="max-content m-0 p-0 font-semibold truncate"
                onClick={(e) =>
                  onClickFilterHandler(e, adminLevel3, "admin_level_3")
                }
              >
                {adminLevel3.slice(0, 16) +
                  (adminLevel3.length > 16 ? "..." : "")}
              </Button>
            </Tooltip>
            {adminLevel3 && <span className="mr-1">,</span>}
            <Tooltip title={adminLevel1}>
              <Button
                type="text"
                size="small"
                className="max-content m-0 p-0 font-semibold shrink-0"
                onClick={(e) =>
                  onClickFilterHandler(e, adminLevel1, "admin_level_1")
                }
              >
                {countryList[adminLevel1 as keyof typeof countryList]}
              </Button>
            </Tooltip>
          </div>
          <div className="flex flex-col items-end shrink-0 pl-1">
            {typeof score === "number" && (
              <Tag
                color="purple"
                className="m-0 mb-0.5 px-1 py-0 text-[10px] leading-4"
                data-testid="dataset-semantic-score"
              >
                {Math.round(score * 100)}% match
              </Tag>
            )}
            {isPrivate && (
              <Tag color="gold" className="mb-1 mr-0">
                Private
              </Tag>
            )}
            <div className="pt-0.5 text-xs whitespace-nowrap">
              {new Date(
                parseInt(item.aquisition_year),
                item.aquisition_month ? parseInt(item.aquisition_month) - 1 : 0,
                item.aquisition_day ? parseInt(item.aquisition_day) : 1,
              ).toLocaleDateString("en-GB", {
                year: "numeric",
                ...(item.aquisition_month && { month: "numeric" }),
                ...(item.aquisition_day && { day: "numeric" }),
              })}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <Tooltip title={item.authors?.join(", ")}>
              <Button
                size="small"
                className="inline-block max-w-full min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left font-medium"
                onClick={(e) =>
                  onClickFilterHandler(e, firstAuthor, "authors_image")
                }
              >
                {truncatedFirstAuthor}
                {item.authors && item.authors.length > 1
                  ? ` +${item.authors.length - 1}`
                  : ""}
              </Button>
            </Tooltip>
          </div>

          <Tooltip title={biomeName || "Unknown biome"}>
            <Tag
              data-testid={
                biomeName ? "dataset-biome-filter" : "dataset-biome-label"
              }
              color={biomeColor}
              className="m-0 inline-flex w-fit shrink-0 cursor-pointer select-none"
              onClick={(e) => {
                if (!biomeName) return;
                onClickFilterHandler(e, biomeName, "biome");
              }}
            >
              {`${biomeIcon} `}
              {truncateBiomeLabel(biomeLabel)}
            </Tag>
          </Tooltip>
        </div>
      </div>
    </div>
  );
};

export default ListItem;
