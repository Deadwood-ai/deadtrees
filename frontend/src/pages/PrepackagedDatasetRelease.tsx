import {
  ArrowLeftOutlined,
  DatabaseOutlined,
  FileOutlined,
  LoginOutlined,
} from "@ant-design/icons";
import { Alert, Button, Empty, Skeleton, message } from "antd";
import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { ReleasePreviewStrip } from "../components/Releases/ReleasePreviewStrip";
import {
  useCreatePrepackagedDownloadGrant,
  usePrepackagedDatasets,
} from "../hooks/usePrepackagedDatasets";
import { useAuth } from "../hooks/useAuthProvider";
import { getPrepackagedDatasetPreviewTiles } from "../utils/prepackagedDatasetPreviews";
import {
  formatPrepackagedBytes,
  formatPrepackagedDate,
  getLatestPrepackagedVersion,
  prepackagedKindLabel,
  prepackagedNumberFormatter,
} from "../utils/prepackagedDatasets";

export default function PrepackagedDatasetRelease() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const [messageApi, contextHolder] = message.useMessage();
  const { session } = useAuth();
  const token = session?.access_token;
  const { data, isLoading, error } = usePrepackagedDatasets(token);
  const grantMutation = useCreatePrepackagedDownloadGrant(token);
  const returnTo = `/releases/${slug ?? ""}`;
  const handleSignIn = () =>
    navigate(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`);

  const datasetPackage = useMemo(
    () => data?.find((candidate) => candidate.slug === slug),
    [data, slug],
  );
  const latestVersion = datasetPackage
    ? getLatestPrepackagedVersion(datasetPackage)
    : null;
  const previewTiles = datasetPackage
    ? getPrepackagedDatasetPreviewTiles(datasetPackage)
    : [];

  const packageStats = latestVersion
    ? [
        {
          label: "Package size",
          value: formatPrepackagedBytes(latestVersion.size_bytes),
        },
        {
          label: "Datasets",
          value:
            latestVersion.dataset_count === null
              ? "Unknown"
              : prepackagedNumberFormatter.format(latestVersion.dataset_count),
        },
        {
          label: "Artifacts",
          value:
            latestVersion.artifact_count === null
              ? "Unknown"
              : prepackagedNumberFormatter.format(latestVersion.artifact_count),
        },
        {
          label: "Built",
          value: formatPrepackagedDate(latestVersion.built_at),
        },
      ]
    : [];
  const manifest = latestVersion?.manifest ?? {};
  const manifestDatasetCount =
    typeof manifest.used_dataset_count === "number"
      ? prepackagedNumberFormatter.format(manifest.used_dataset_count)
      : null;
  const manifestLicense =
    typeof manifest.license_filter === "string"
      ? manifest.license_filter
      : null;

  const handleDownload = async (versionId: number) => {
    if (!token) {
      handleSignIn();
      return;
    }

    try {
      const grant = await grantMutation.mutateAsync(versionId);
      window.location.assign(grant.download_url);
    } catch (downloadError) {
      const errorMessage =
        downloadError instanceof Error
          ? downloadError.message
          : "Could not start the package download.";
      void messageApi.error(errorMessage);
    }
  };

  return (
    <main className="min-h-screen bg-[#f8faf9] pt-20 md:pt-24">
      {contextHolder}

      <section className="border-b border-gray-200/80 bg-white">
        <div className="mx-auto max-w-7xl px-4 pt-8 md:px-8">
          <Button
            icon={<ArrowLeftOutlined />}
            onClick={() => navigate("/releases")}
            type="text"
            className="px-0"
          >
            Back to releases
          </Button>
        </div>

        {isLoading && (
          <div className="mx-auto max-w-7xl px-4 pb-16 pt-8 md:px-8">
            <Skeleton active paragraph={{ rows: 8 }} />
          </div>
        )}

        {error && (
          <div className="mx-auto max-w-7xl px-4 pb-16 pt-8 md:px-8">
            <Alert
              type="error"
              showIcon
              message="Could not load release"
              description={error instanceof Error ? error.message : undefined}
            />
          </div>
        )}

        {!isLoading && !error && !datasetPackage && (
          <div className="mx-auto max-w-7xl px-4 pb-16 pt-8 md:px-8">
            <Empty description="This release was not found." />
          </div>
        )}

        {datasetPackage && latestVersion && (
          <div className="mx-auto grid max-w-7xl gap-8 px-4 pb-10 pt-8 md:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)] md:gap-12 md:px-8 md:pb-14">
            <div className="min-w-0">
              <p className="m-0 text-sm font-semibold uppercase tracking-wider text-[#1B5E35] md:text-base">
                Data package · {prepackagedKindLabel(datasetPackage.kind)} ·{" "}
                {datasetPackage.slug}
              </p>
              <h1 className="m-0 mt-3 text-4xl font-semibold leading-[1.1] text-gray-950 md:text-5xl">
                {datasetPackage.title}
              </h1>
              <p className="mt-5 max-w-3xl text-lg leading-8 text-gray-600">
                {datasetPackage.description || datasetPackage.summary}
              </p>
              <p className="mt-6 max-w-2xl text-sm leading-6 text-gray-500">
                Metadata is public. ZIP downloads require sign-in and use
                short-lived links.
              </p>
            </div>

            <div className="self-start overflow-hidden rounded-lg border border-gray-200 bg-white">
              <ReleasePreviewStrip
                tiles={previewTiles}
                className="grid grid-cols-4 gap-px bg-gray-200"
                tileClassName="aspect-[4/3] [&:nth-child(n+5)]:col-span-2 [&:nth-child(n+5)]:aspect-[8/3]"
              />
            </div>
          </div>
        )}
      </section>

      {datasetPackage && latestVersion && (
        <>
          <section className="mx-auto max-w-7xl px-4 py-8 md:px-8 md:py-10">
            <div className="rounded-lg border border-gray-200 bg-white p-5 md:p-6">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                <FileOutlined />
                Package snapshot
              </div>

              <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.85fr)]">
                <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4 lg:grid-cols-2">
                  {packageStats.map((stat) => (
                    <div
                      key={stat.label}
                      className="border-l border-gray-200 pl-4"
                    >
                      <div className="text-2xl font-semibold text-[#1B5E35]">
                        {stat.value}
                      </div>
                      <div className="mt-1 text-xs font-semibold uppercase text-gray-500">
                        {stat.label}
                      </div>
                    </div>
                  ))}
                </div>

                <div>
                  <div className="break-all text-sm font-semibold leading-6 text-gray-950">
                    {latestVersion.file_name}
                  </div>
                  <dl className="mt-4 grid gap-3 text-sm text-gray-600 sm:grid-cols-2">
                    <div>
                      <dt className="font-semibold text-gray-800">Published</dt>
                      <dd className="m-0 mt-0.5">
                        {formatPrepackagedDate(latestVersion.published_at)}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-semibold text-gray-800">Version</dt>
                      <dd className="m-0 mt-0.5">v{latestVersion.version}</dd>
                    </div>
                    {manifestDatasetCount && (
                      <div>
                        <dt className="font-semibold text-gray-800">
                          Source datasets
                        </dt>
                        <dd className="m-0 mt-0.5">{manifestDatasetCount}</dd>
                      </div>
                    )}
                    {manifestLicense && (
                      <div>
                        <dt className="font-semibold text-gray-800">License</dt>
                        <dd className="m-0 mt-0.5">{manifestLicense}</dd>
                      </div>
                    )}
                  </dl>
                  {latestVersion.known_issues && (
                    <Alert
                      className="mt-4"
                      type="warning"
                      showIcon
                      message={latestVersion.known_issues}
                    />
                  )}
                </div>
              </div>
            </div>
          </section>

          <section className="border-t border-gray-200 bg-white">
            <div className="mx-auto max-w-7xl px-4 py-12 md:px-8 md:py-14">
              <div className="flex max-w-4xl flex-col gap-6 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="m-0 text-sm font-semibold uppercase tracking-wider text-[#1B5E35]">
                    Download access
                  </p>
                  <h2 className="m-0 mt-3 text-3xl font-semibold leading-tight text-gray-950 md:text-4xl">
                    Get the current package
                  </h2>
                  <p className="mt-3 max-w-2xl text-base leading-7 text-gray-600">
                    Downloads use short-lived links so access can be limited and
                    audited without exposing the storage server directly.
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-3">
                  <Button
                    type="primary"
                    size="large"
                    icon={<DatabaseOutlined />}
                    loading={
                      grantMutation.isPending &&
                      grantMutation.variables === latestVersion.id
                    }
                    onClick={() => handleDownload(latestVersion.id)}
                    disabled={!token}
                    className="min-h-11"
                  >
                    Download ZIP
                  </Button>
                  {!token && (
                    <Button
                      size="large"
                      icon={<LoginOutlined />}
                      onClick={handleSignIn}
                      className="min-h-11"
                    >
                      Sign in
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
