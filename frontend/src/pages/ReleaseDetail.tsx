import { Navigate, useParams } from "react-router-dom";

import { getPublicReleaseBySlug } from "../data/releases";
import DroneMappingGuideRelease from "./DroneMappingGuideRelease";
import DteAerialRelease from "./DteAerialRelease";
import PrepackagedDatasetRelease from "./PrepackagedDatasetRelease";

export default function ReleaseDetail() {
  const { slug } = useParams();
  const release = slug ? getPublicReleaseBySlug(slug) : undefined;

  if (!release) {
    return <PrepackagedDatasetRelease />;
  }

  if (release.type === "benchmark-dataset") {
    return <DteAerialRelease release={release} />;
  }

  if (release.type === "guide") {
    return <DroneMappingGuideRelease release={release} />;
  }

  return <Navigate to="/releases" replace />;
}
