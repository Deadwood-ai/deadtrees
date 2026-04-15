import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "antd";
import { CloudUploadOutlined, GlobalOutlined, DatabaseOutlined } from "@ant-design/icons";
import { useDesktopOnlyFeature } from "../../hooks/useDesktopOnlyFeature";
import { useAnalytics } from "../../hooks/useAnalytics";
import DataGallery from "./DataGallery";

const UPLOAD_VIDEO_URL = "https://data2.deadtrees.earth/assets/v1/videos/upload.mp4";

const MiniSatelliteMap = lazy(() => import("./MiniSatelliteMap"));

const DeferredMiniSatelliteMap = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (isVisible || !containerRef.current) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "250px 0px" },
    );

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [isVisible]);

  return (
    <div ref={containerRef} className="h-full w-full">
      {isVisible ? (
        <Suspense fallback={<div className="h-full w-full animate-pulse bg-gray-100" />}>
          <MiniSatelliteMap />
        </Suspense>
      ) : (
        <div className="h-full w-full animate-pulse bg-gray-100" />
      )}
    </div>
  );
};

const HowItWorks = () => {
  const navigate = useNavigate();
  const { isMobile, runDesktopOnlyAction } = useDesktopOnlyFeature();
  const { track } = useAnalytics("home");

  return (
    <section className="w-full bg-[#F8FAF9] border-t border-slate-200/50 py-24 md:py-32">
      <div className="m-auto max-w-6xl px-4 md:px-8">
        <div className="mb-20 text-center">
        <p className="mb-2 text-lg font-semibold uppercase tracking-wider text-[#1B5E35]">
          The Pipeline
        </p>
        <h2 className="m-0 text-4xl font-semibold text-gray-800 md:text-5xl">
          From drone imagery to global models
        </h2>
        <p className="mx-auto mt-6 max-w-3xl text-lg text-gray-600">
          By integrating Earth observation, machine learning, and ground-based data sources, this initiative aims to bridge the existing gaps in understanding global tree mortality dynamics.
        </p>
      </div>

      <div className="flex flex-col gap-24 md:gap-32">
        {/* Step 1: Drone Upload */}
        <div className="flex flex-col items-center gap-10 md:flex-row lg:gap-20">
          <div className="flex-1 text-left order-2 md:order-1">
            <div className="mb-4 inline-flex items-center justify-center rounded-full bg-[#E8F3EB] px-4 py-1.5 text-sm font-bold text-[#1B5E35]">
              STEP 01
            </div>
            <h3 className="mb-4 text-3xl font-semibold text-gray-800 md:text-4xl">
              Contribute Drone Data
            </h3>
            <p className="mb-8 text-lg text-gray-600">
              Upload your high-resolution drone imagery of forests (resolution &lt; 10 cm) via your user profile. <strong>All forest data is valuable</strong>, whether it contains standing deadwood or healthy trees. We support direct uploads of finished <strong>orthophotos (GeoTIFF)</strong> as well as <strong>raw drone imagery (ZIP)</strong>. For raw images, our pipeline automatically generates orthomosaics using OpenDroneMap (ODM).
            </p>
            <Button
              type="primary"
              size="large"
              icon={<CloudUploadOutlined />}
              className="min-h-11 px-6"
              onClick={() => {
                track("landing_cta_clicked", {
                  cta_name: "pipeline_upload_via_profile",
                  action_target: "/profile",
                  ...(isMobile ? { blocked_reason: "mobile" } : {}),
                });
                runDesktopOnlyAction("upload", () => navigate("/profile"));
              }}
            >
                Upload via Profile
            </Button>
          </div>
          <div className="w-full flex-1 order-1 md:order-2">
            <div className="relative w-full overflow-hidden rounded-2xl bg-white shadow-xl ring-1 ring-black/5">
              <video
                src={UPLOAD_VIDEO_URL}
                autoPlay
                loop
                muted
                playsInline
                preload="metadata"
                className="w-full rounded-2xl object-contain"
              />
            </div>
          </div>
        </div>

        {/* Step 2: AI Processing & Archive */}
        <div className="flex flex-col gap-10 pt-4">
          <div className="text-center md:mx-auto md:max-w-3xl">
            <div className="mb-4 inline-flex items-center justify-center rounded-full bg-[#E8F3EB] px-4 py-1.5 text-sm font-bold text-[#1B5E35]">
              STEP 02
            </div>
            <h3 className="mb-4 text-3xl font-semibold text-gray-800 md:text-4xl">
              AI Processing & Open Archive
            </h3>
            <p className="text-lg text-gray-600">
              Our models automatically detect deadwood and forest cover in your uploaded imagery through semantic segmentation. The results are aggregated into an analysis-ready training database, freely accessible for researchers worldwide.
            </p>
          </div>
          <div className="-mx-4 md:mx-0 relative z-10">
             <DataGallery hideHeader={true} />
          </div>
          <div className="flex justify-center">
            <Link to="/dataset">
              <Button
                size="large"
                icon={<DatabaseOutlined />}
                className="min-h-11 px-6"
                onClick={() =>
                  track("landing_cta_clicked", {
                    cta_name: "pipeline_browse_dataset_archive",
                    action_target: "/dataset",
                  })
                }
              >
                Browse Dataset Archive
              </Button>
            </Link>
          </div>
        </div>

        {/* Step 3: Satellite Upscaling */}
        <div className="flex flex-col items-center gap-10 md:flex-row lg:gap-20">
          <div className="w-full flex-1">
            <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl shadow-xl ring-1 ring-black/5 bg-gray-100">
              <DeferredMiniSatelliteMap />
            </div>
          </div>
          <div className="flex-1 text-left">
            <div className="mb-4 inline-flex items-center justify-center rounded-full bg-[#E8F3EB] px-4 py-1.5 text-sm font-bold text-[#1B5E35]">
              STEP 03
            </div>
            <h3 className="mb-4 text-3xl font-semibold text-gray-800 md:text-4xl">
              Satellite Upscaling
            </h3>
            <p className="mb-8 text-lg text-gray-600">
              The high-resolution ground truth trains our satellite models to generate large-scale spatiotemporal maps of forest mortality at the European scale. We provide embedded visualization and download of these extensive tree mortality products.
            </p>
            <Link to="/deadtrees">
              <Button
                type="primary"
                size="large"
                icon={<GlobalOutlined />}
                className="min-h-11 px-6"
                onClick={() =>
                  track("landing_cta_clicked", {
                    cta_name: "pipeline_explore_satellite_maps",
                    action_target: "/deadtrees",
                  })
                }
              >
                Explore Satellite Maps
              </Button>
            </Link>
          </div>
        </div>
      </div>
      </div>
    </section>
  );
};

export default HowItWorks;
