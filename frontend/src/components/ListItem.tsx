import { Button, Tag, Tooltip } from "antd";
import { useNavigate } from "react-router-dom";
import { IDataset } from "../types/dataset";
import { Settings } from "../config";
import countryList from "../utils/countryList";
import { useDatasetDetailsMap } from "../hooks/useDatasetDetailsMapProvider";
import { getBiomeEmoji, getBiomeTagColor, truncateBiomeLabel } from "../utils/biomeDisplay";

interface ListItemProps {
  item: IDataset;
  index: number;
  setHoveredItem: ((id: number | null) => void) | undefined;
  hoveredItem: number | null;
  onFilterClick: (
    filterValue: string,
    filterType: "platform" | "license" | "authors_image" | "admin_level_1" | "admin_level_3" | "biome",
  ) => void;
}

const ListItem = ({ item, index, setHoveredItem, hoveredItem, onFilterClick }: ListItemProps) => {
  const navigate = useNavigate();
  const { setNavigationSource } = useDatasetDetailsMap();

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

  const onClickHandler = (item: IDataset) => {
    setNavigationSource("dataset");
    navigate(`/dataset/${item.id}`);
  };

  const onClickFilterHandler = (
    e: React.MouseEvent,
    filter: string,
    filterType: "platform" | "license" | "authors_image" | "admin_level_1" | "admin_level_3" | "biome",
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

  return (
    <div
      key={index}
      className={`flex rounded-md p-2 transition duration-150 ease-in-out ${
        hoveredItem === item.id ? "bg-gray-200" : "bg-white hover:bg-gray-100"
      }`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={() => onClickHandler(item)}
    >
      <div className="relative h-16 w-16 min-h-16 min-w-16 shrink-0 overflow-hidden rounded-lg">
        <img
          src={item.thumbnail_path ? Settings.THUMBNAIL_URL + item.thumbnail_path : "/assets/tree-icon.png"}
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
                onClick={(e) => onClickFilterHandler(e, adminLevel3, "admin_level_3")}
              >
                {adminLevel3.slice(0, 16) + (adminLevel3.length > 16 ? "..." : "")}
              </Button>
            </Tooltip>
            {adminLevel3 && <span className="mr-1">,</span>}
            <Tooltip title={adminLevel1}>
              <Button
                type="text"
                size="small"
                className="max-content m-0 p-0 font-semibold shrink-0"
                onClick={(e) => onClickFilterHandler(e, adminLevel1, "admin_level_1")}
              >
                {countryList[adminLevel1 as keyof typeof countryList]}
              </Button>
            </Tooltip>
          </div>
          <div className="flex flex-col items-end shrink-0 pl-1">
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
                onClick={(e) => onClickFilterHandler(e, firstAuthor, "authors_image")}
              >
                {truncatedFirstAuthor}
                {item.authors && item.authors.length > 1 ? ` +${item.authors.length - 1}` : ""}
              </Button>
            </Tooltip>
          </div>

          <Tooltip title={biomeName || "Unknown biome"}>
            <Tag
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
