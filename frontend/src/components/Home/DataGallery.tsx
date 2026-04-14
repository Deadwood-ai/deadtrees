import { Button, Carousel, Tooltip, Tag } from "antd";
import { useMemo, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { LeftOutlined, RightOutlined } from "@ant-design/icons";
import { useData } from "../../hooks/useDataProvider";
import { Settings } from "../../config";
import countryList from "../../utils/countryList";
import { useDatasetDetailsMap } from "../../hooks/useDatasetDetailsMapProvider";
import parseBBox from "../../utils/parseBBox";
import { isDatasetViewable } from "../../utils/datasetVisibility";

// Convert a geographic bounding box to area in hectares
const calculateAreaFromBBox = (bboxArray: number[]): number => {
  if (!bboxArray || bboxArray.length !== 4) return 0;

  const [minLon, minLat, maxLon, maxLat] = bboxArray;

  // Approximate conversion (this is a simplification that works reasonably well for small areas)
  // 1 degree of latitude is approximately 111.32 km
  // 1 degree of longitude varies with latitude: 111.32 * cos(latitude in radians)
  const latDistance = (maxLat - minLat) * 111.32; // in km

  // Average latitude for longitude calculation
  const avgLat = (minLat + maxLat) / 2;
  const lonDistance = (maxLon - minLon) * 111.32 * Math.cos(avgLat * (Math.PI / 180)); // in km

  // Area in square kilometers
  const areaKm2 = latDistance * lonDistance;

  // Convert to hectares (1 km² = 100 hectares)
  return areaKm2 * 100;
};

const Stat = ({ title, value, unit }: { title: string; value: string; unit: string }) => {
  return (
    <div className="flex flex-col items-center justify-center p-4">
      <div className="flex items-baseline gap-1.5">
        <span className="text-3xl font-semibold text-[#FFB31C]">{value}</span>
        {unit && <span className="text-base font-semibold text-[#FFB31C]/80">{unit}</span>}
      </div>
      <span className="mt-1 text-[11px] font-bold uppercase tracking-widest text-gray-400">{title}</span>
    </div>
  );
};

const Stats = ({ datasets }: { datasets: any[] }) => {
  const stats = useMemo(() => {
    if (!datasets.length) return { orthophotos: 0, area: 0, countries: 0, fileSize: 0 };

    // Calculate orthophoto count
    const orthophotos = datasets.length;

    // Calculate total area from bounding boxes
    let totalArea = 0;
    datasets.forEach((item) => {
      if (item.bbox) {
        const parsedBBox = parseBBox(item.bbox);
        if (parsedBBox) {
          totalArea += calculateAreaFromBBox(parsedBBox);
        }
      }
    });

    // Unique countries
    const countries = new Set<string>();
    datasets.forEach((item) => {
      if (item.admin_level_1) {
        countries.add(item.admin_level_1);
      }
    });

    // Total file size in TB
    const totalFileSizeBytes = datasets.reduce((sum, item) => {
      // Convert from MB to TB (1 TB = 1,048,576 MB)
      return sum + (item.ortho_file_size || 0);
    }, 0);

    // Convert MB to TB
    const totalFileSizeTB = totalFileSizeBytes / 1_048_576;

    return {
      orthophotos,
      area: totalArea,
      countries: countries.size,
      fileSize: totalFileSizeTB,
    };
  }, [datasets]);

  return (
    <div className="mt-4 flex flex-col justify-center rounded-2xl bg-white/50 py-6 md:mt-8">
      <div className="grid grid-cols-2 gap-y-8 md:flex md:justify-around md:gap-y-0">
        <Stat title="Orthophotos" value={stats.orthophotos.toLocaleString()} unit="" />
        <Stat title="Area Covered" value={Math.round(stats.area).toLocaleString()} unit="ha" />
        <Stat title="Countries" value={stats.countries.toString()} unit="" />
        <Stat title="Data Size" value={stats.fileSize.toFixed(2)} unit="TB" />
      </div>
    </div>
  );
};

const DataGallery = ({ hideHeader = false }: { hideHeader?: boolean }) => {
  const { data } = useData();
  const carouselRef = useRef<any>(null);
  const navigate = useNavigate();
  const { setNavigationSource } = useDatasetDetailsMap();

  const viewableData = useMemo(() => {
    if (!data) return [];
    return data.filter((item) => isDatasetViewable(item));
  }, [data]);

  const sortedUniqueData = useMemo(() => {
    if (!viewableData.length) return [];

    const sorted = [...viewableData].sort((a, b) => b.id - a.id);

    // Debug: Check initial data
    // console.log("Initial data count:", sorted.length);

    // First filter for required fields using centralized visibility check
    const filtered = sorted.filter((item) => {
      // Carousel-specific requirements (authors and thumbnail for display)
      if (!item.authors || !Array.isArray(item.authors) || !item.thumbnail_path) {
        return false;
      }
      return true;
    });

    // Debug: Check after required fields filter
    // console.log("After required fields filter:", filtered.length);
    // console.log(
    //   "Sample authors:",
    //   filtered.slice(0, 5).map((item) => item.authors),
    // );

    // Create a map to store one entry per author
    const authorMap = new Map();

    // Take only the first entry for each author in the authors array
    filtered.forEach((item) => {
      item.authors.forEach((author: string) => {
        const authorKey = author.trim().toLowerCase();
        if (!authorMap.has(authorKey)) {
          authorMap.set(authorKey, item);
        }
      });
    });

    // Convert map values back to array and remove duplicates
    const oneImagePerAuthor = Array.from(new Set(authorMap.values()));

    // Debug: Final result
    // console.log("Final unique entries:", oneImagePerAuthor.length);
    // console.log(
    //   "Final unique authors:",
    //   oneImagePerAuthor.map((item) => item.authors),
    // );

    return oneImagePerAuthor;
  }, [viewableData]);

  const onClickHandler = useCallback((id: number) => {
    setNavigationSource("dataset");
    navigate(`/dataset/${id}`);
  }, [navigate, setNavigationSource]);

  const next = useCallback(() => carouselRef.current?.next(), []);
  const previous = useCallback(() => carouselRef.current?.prev(), []);

  const settings = useMemo(() => ({
    dots: false,
    infinite: true,
    speed: 500,
    slidesToShow: 4,
    slidesToScroll: 1,
    arrows: false,
    responsive: [
      {
        breakpoint: 1024,
        settings: {
          slidesToShow: 2,
          slidesToScroll: 1,
        },
      },
      {
        breakpoint: 640,
        settings: {
          slidesToShow: 1,
          slidesToScroll: 1,
        },
      },
    ],
  }), []);

  return (
    <div className="w-full">
      <div className={!hideHeader ? "m-auto w-full rounded-xl bg-gradient-to-t from-white to-[#1B5E35]/5 p-8 md:mt-36 md:w-full" : "w-full"}>
        {!hideHeader && (
          <>
            <p className="text-center text-lg font-semibold text-[#1B5E35]">EXPLORE OUR DATABASE</p>
            <p className="m-0 text-center text-4xl font-semibold md:text-5xl">Global Tree Mortality Atlas</p>
            <p className="m-auto max-w-4xl pt-8 text-left text-lg text-gray-500">
              Browse our growing collection of aerial imagery datasets showing tree mortality patterns. Each dataset
              includes high-resolution orthophotos and optional polygon annotations of dead trees, contributed by
              researchers worldwide.
            </p>
          </>
        )}
        <div className={`flex flex-col gap-8 ${!hideHeader ? "px-4 pt-8" : "px-0 pt-0"}`}>
          <div className="relative mx-4 md:mx-12">
            <Button
              className="absolute -left-4 top-1/2 z-10 flex !h-12 !w-12 !min-w-0 -translate-y-1/2 items-center justify-center rounded-full border-gray-200 bg-white !p-0 shadow-sm transition-all hover:scale-105 hover:bg-white hover:shadow-md md:-left-12"
              icon={<LeftOutlined className="text-lg text-gray-500" />}
              onClick={previous}
              shape="circle"
            />
            <Button
              className="absolute -right-4 top-1/2 z-10 flex !h-12 !w-12 !min-w-0 -translate-y-1/2 items-center justify-center rounded-full border-gray-200 bg-white !p-0 shadow-sm transition-all hover:scale-105 hover:bg-white hover:shadow-md md:-right-12"
              icon={<RightOutlined className="text-lg text-gray-500" />}
              onClick={next}
              shape="circle"
            />

            <Carousel ref={carouselRef} {...settings}>
              {sortedUniqueData.map((item) => (
                <div key={item.id} className="px-2 py-4">
                  <div
                    className="cursor-pointer rounded-lg bg-white shadow-md transition-shadow duration-200 hover:shadow-lg"
                    onClick={() => onClickHandler(item.id)}
                  >
                    <div className="relative m-2 mt-2 overflow-hidden rounded-lg">
                      <img
                        src={
                          item.thumbnail_path ? Settings.THUMBNAIL_URL + item.thumbnail_path : "/assets/tree-icon.png"
                        }
                        className="h-36 w-48 scale-150 rounded-t-lg object-cover"
                        loading="lazy"
                        alt={`Dataset ${item.id}`}
                      />
                    </div>
                    <div className="p-4">
                      <div className="mb-2 flex items-baseline justify-between">
                        <Tooltip
                          title={
                            item.admin_level_1
                              ? `${item.admin_level_3 || item.admin_level_2 || ""}${item.admin_level_1 ? `, ${item.admin_level_1}` : ""}`
                              : ""
                          }
                        >
                          <span className="max-w-[70%] truncate font-semibold">
                            {item.admin_level_3 || item.admin_level_2
                              ? // If we have level 2 or 3, show it with country
                              `${(item.admin_level_3 || item.admin_level_2).slice(0, 10)}${(item.admin_level_3 || item.admin_level_2).length > 15 ? "..." : ""}${item.admin_level_1 ? `, ${countryList[item.admin_level_1 as keyof typeof countryList]}` : ""}`
                              : // If we only have level 1, just show the country
                              item.admin_level_1
                                ? countryList[item.admin_level_1 as keyof typeof countryList]
                                : ""}
                          </span>
                        </Tooltip>
                        <span className="text-xs text-gray-500">
                          {new Date(
                            parseInt(item.aquisition_year),
                            item.aquisition_month ? parseInt(item.aquisition_month) - 1 : 0,
                            item.aquisition_day ? parseInt(item.aquisition_day) : 1,
                          ).toLocaleDateString("en-GB", {
                            year: "numeric",
                            ...(item.aquisition_month && { month: "numeric" }),
                            ...(item.aquisition_day && { day: "numeric" }),
                          })}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <Tooltip title={item.authors}>
                          <span className="max-w-[70%] truncate text-sm text-gray-600">
                            {item.authors && item.authors.slice(0, 18) + (item.authors.length > 18 ? "..." : "")}
                          </span>
                        </Tooltip>
                        <Tag>{item.platform}</Tag>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </Carousel>
          </div>
          <Stats datasets={viewableData} />
        </div>
        {!hideHeader && (
          <div className="flex justify-center pt-8">
            <Button type="primary" size="large" onClick={() => navigate("/dataset")}>
              Explore all datasets
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};

export default DataGallery;
