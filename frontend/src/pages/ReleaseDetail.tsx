import { Navigate, useParams } from "react-router-dom";

import { getPublicReleaseBySlug } from "../data/releases";
import DteAerialRelease from "./DteAerialRelease";

export default function ReleaseDetail() {
  const { slug } = useParams();
  const release = slug ? getPublicReleaseBySlug(slug) : undefined;

  if (!release) {
    return <Navigate to="/releases" replace />;
  }

  if (release.type === "benchmark-dataset") {
    return <DteAerialRelease release={release} />;
  }

  return <Navigate to="/releases" replace />;
}
