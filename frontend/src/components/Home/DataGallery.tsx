import { Button, Carousel, Tooltip, Tag } from "antd";
import { useMemo, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { LeftOutlined, RightOutlined } from "@ant-design/icons";
import type { CarouselRef } from "antd/es/carousel";
import { Settings } from "../../config";
import countryList from "../../utils/countryList";
import { useDatasetDetailsMap } from "../../hooks/useDatasetDetailsMapProvider";
import {
  useHomeDatasetTeasers,
  useHomeStats,
  type IHomeDatasetTeaser,
  type IHomeStats,
} from "../../hooks/useHomeReadModels";

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

const getDatasetLocationLabel = (item: IHomeDatasetTeaser): string => {
  const place = item.admin_level_3 || item.admin_level_2;

  if (place) {
    const countryName = item.admin_level_1
      ? countryList[item.admin_level_1 as keyof typeof countryList] ?? item.admin_level_1
      : "";
    const country = countryName ? `, ${countryName}` : "";
    const truncatedPlace = place.length > 10 ? `${place.slice(0, 10)}...` : place;
    return `${truncatedPlace}${country}`;
  }

  return item.admin_level_1
    ? countryList[item.admin_level_1 as keyof typeof countryList] ?? item.admin_level_1
    : "";
};

const getDatasetDateLabel = (item: IHomeDatasetTeaser): string => {
  if (!item.aquisition_year) return "Unknown date";

  return new Date(
    item.aquisition_year,
    item.aquisition_month ? item.aquisition_month - 1 : 0,
    item.aquisition_day ? item.aquisition_day : 1,
  ).toLocaleDateString("en-GB", {
    year: "numeric",
    ...(item.aquisition_month && { month: "numeric" }),
    ...(item.aquisition_day && { day: "numeric" }),
  });
};

type StatsProps = { stats: IHomeStats | null | undefined };

const Stats = ({ stats }: StatsProps) => {
  return (
    <div className="mt-4 flex flex-col justify-center rounded-2xl bg-white/50 py-6 md:mt-8">
      <div className="grid grid-cols-2 gap-y-8 md:flex md:justify-around md:gap-y-0">
        <Stat title="Orthophotos" value={(stats?.dataset_count ?? 0).toLocaleString()} unit="" />
        <Stat title="Area Covered" value={Math.round(stats?.area_covered_ha ?? 0).toLocaleString()} unit="ha" />
        <Stat title="Countries" value={(stats?.country_count ?? 0).toString()} unit="" />
        <Stat title="Data Size" value={(stats?.data_size_tb ?? 0).toFixed(2)} unit="TB" />
      </div>
    </div>
  );
};

const DataGallery = ({ hideHeader = false }: { hideHeader?: boolean }) => {
  const { data: galleryData = [], isLoading } = useHomeDatasetTeasers();
  const { data: stats } = useHomeStats();
  const carouselRef = useRef<CarouselRef | null>(null);
  const navigate = useNavigate();
  const { setNavigationSource } = useDatasetDetailsMap();

  const visibleGalleryData = useMemo(() => {
    if (!galleryData.length) return [];

    return galleryData.filter((item) => {
      if (!item.authors || !Array.isArray(item.authors) || !item.thumbnail_path) {
        return false;
      }
      return true;
    });
  }, [galleryData]);

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

            {isLoading ? (
              <div
                className="h-64 animate-pulse rounded-lg bg-white/70"
                data-testid="home-data-gallery-loading"
              />
            ) : (
              <Carousel ref={carouselRef} {...settings} data-testid="home-data-gallery">
                {visibleGalleryData.map((item) => (
                  <div key={item.id} className="px-2 py-4">
                    <button
                      className="block w-full cursor-pointer rounded-lg border-0 bg-white p-0 text-left shadow-md transition-shadow duration-200 hover:shadow-lg"
                      onClick={() => onClickHandler(item.id)}
                      type="button"
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
                              {getDatasetLocationLabel(item)}
                            </span>
                          </Tooltip>
                          <span className="text-xs text-gray-500">
                            {getDatasetDateLabel(item)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <Tooltip title={item.authors?.join(", ")}>
                            <span className="max-w-[70%] truncate text-sm text-gray-600">
                              {item.authors?.join(", ")}
                            </span>
                          </Tooltip>
                          <Tag>{item.platform}</Tag>
                        </div>
                      </div>
                    </button>
                  </div>
                ))}
              </Carousel>
            )}
          </div>
          <Stats stats={stats} />
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
