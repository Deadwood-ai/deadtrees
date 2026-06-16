import { DatabaseOutlined } from "@ant-design/icons";
import { Alert, Skeleton, Tag } from "antd";

import { usePrepackagedDatasets } from "../../hooks/usePrepackagedDatasets";
import {
  formatPrepackagedBytes,
  formatPrepackagedDate,
  getLatestPrepackagedVersion,
  prepackagedKindLabel,
} from "../../utils/prepackagedDatasets";
import { PrepackagedDownloadButton } from "./PrepackagedDownloadButton";

interface PrepackagedReleaseDownloadsProps {
  packageSlugs: string[];
  returnTo: string;
}

export function PrepackagedReleaseDownloads({
  packageSlugs,
  returnTo,
}: PrepackagedReleaseDownloadsProps) {
  const { data, isLoading, error } = usePrepackagedDatasets();

  if (isLoading) {
    return <Skeleton active paragraph={{ rows: 5 }} />;
  }

  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        message="Could not load dataset packages"
        description={error instanceof Error ? error.message : undefined}
      />
    );
  }

  const catalog = data ?? [];
  const packageBySlug = new Map(
    catalog.map((candidate) => [candidate.slug, candidate]),
  );
  const packages = packageSlugs
    .map((slug) => packageBySlug.get(slug))
    .filter((candidate): candidate is NonNullable<typeof candidate> =>
      Boolean(candidate),
    );
  const missingPackageSlugs = packageSlugs.filter(
    (slug) => !packageBySlug.has(slug),
  );
  const missingPackageDescription = `Waiting for: ${missingPackageSlugs.join(", ")}`;

  if (!packages.length) {
    return (
      <Alert
        type={missingPackageSlugs.length > 0 ? "warning" : "info"}
        showIcon
        message="Dataset package is not available yet"
        description={
          missingPackageSlugs.length > 0
            ? missingPackageDescription
            : "The release preview is public; downloadable ZIP packages will appear here when they are published."
        }
      />
    );
  }

  return (
    <div className="grid gap-4">
      {missingPackageSlugs.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message="Some dataset packages are not available yet"
          description={missingPackageDescription}
        />
      )}
      {packages.map((datasetPackage) => {
        const latestVersion = getLatestPrepackagedVersion(datasetPackage);
        return (
          <article
            key={datasetPackage.slug}
            className="rounded-lg border border-gray-200 bg-white p-5"
          >
            <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Tag className="m-0">
                    {prepackagedKindLabel(datasetPackage.kind)}
                  </Tag>
                  {latestVersion && (
                    <Tag className="m-0" color="green">
                      v{latestVersion.version}
                    </Tag>
                  )}
                </div>
                <h3 className="m-0 mt-3 text-xl font-semibold leading-tight text-gray-950">
                  {datasetPackage.title}
                </h3>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-600">
                  {datasetPackage.summary}
                </p>
                {latestVersion && (
                  <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-gray-500">
                    <span>
                      {formatPrepackagedBytes(latestVersion.size_bytes)}
                    </span>
                    <span>
                      Published{" "}
                      {formatPrepackagedDate(latestVersion.published_at)}
                    </span>
                  </div>
                )}
                {latestVersion?.known_issues && (
                  <Alert
                    className="mt-4"
                    type="warning"
                    showIcon
                    message={latestVersion.known_issues}
                  />
                )}
              </div>

              <PrepackagedDownloadButton
                versionId={latestVersion?.id}
                fileName={latestVersion?.file_name}
                returnTo={returnTo}
                icon={<DatabaseOutlined />}
                className="min-h-11 shrink-0"
              >
                Download ZIP
              </PrepackagedDownloadButton>
            </div>
          </article>
        );
      })}
    </div>
  );
}
