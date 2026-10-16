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

  // Internal, core-team-only release: kept out of the public releases catalogue.
  if (slug === "disturbance-benchmark") {
    return (
      <BenchmarkAccess>
        <Suspense fallback={null}>
          <DisturbanceBenchmarkRelease />
        </Suspense>
      </BenchmarkAccess>
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
