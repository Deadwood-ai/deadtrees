import { Navigate, useParams } from "react-router-dom";
import { lazy, Suspense } from "react";

import { getPublicReleaseBySlug } from "../data/releases";
import DroneMappingGuideRelease from "./DroneMappingGuideRelease";
import DteAerialRelease from "./DteAerialRelease";
import PrepackagedDatasetRelease from "./PrepackagedDatasetRelease";
import BenchmarkAccess from "../components/DisturbanceBenchmark/BenchmarkAccess";

const DisturbanceBenchmarkRelease = lazy(
  () => import("./DisturbanceBenchmarkRelease"),
);

export default function ReleaseDetail() {
  const { slug } = useParams();
  const release = slug ? getPublicReleaseBySlug(slug) : undefined;

  // Deployment switch only: the serving proxy must authorize the page AND assets.
  // Keep this internal release out of the public releases catalogue.
  if (slug === "disturbance-benchmark") {
    return import.meta.env.VITE_ENABLE_INTERNAL_DISTURBANCE_BENCHMARK ===
      "true" ? (
      <BenchmarkAccess>
        <Suspense fallback={<p role="status">Loading benchmark…</p>}>
          <DisturbanceBenchmarkRelease />
        </Suspense>
      </BenchmarkAccess>
    ) : (
      <Navigate to="/releases" replace />
    );
  }

  if (!release) {
    return <PrepackagedDatasetRelease />;
  }

  if (release.type === "benchmark-dataset") {
    return <DteAerialRelease release={release} />;
  }

  if (release.type === "guide") {
    return <DroneMappingGuideRelease release={release} />;
  }

  if (release.type === "map") {
    return <Navigate to={release.links.artifact} replace />;
  }

  return <Navigate to="/releases" replace />;
}
