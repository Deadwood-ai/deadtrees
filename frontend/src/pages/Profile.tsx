import { useMemo, useState } from "react";
import { Button, Popover, Segmented, Typography } from "antd";
import { FileOutlined, QuestionCircleOutlined } from "@ant-design/icons";
import { useAuth } from "../hooks/useAuthProvider";
import DataTable from "../components/DataTable";
import UploadButton from "../components/Upload/UploadButton";
import { useUserDatasets } from "../hooks/useDatasets";
import { useMyFlags } from "../hooks/useDatasetFlags";
import { useSharedWithMe } from "../hooks/useDatasetAccess";
import { useDatasetsInPublication, useMyPublications } from "../hooks/useDataPublications";
import PublicationModal from "../components/PublicationModal";
import PublicationsTable from "../components/PublicationsTable";
import SharedWithMeTable from "../components/DatasetAccess/SharedWithMeTable";
import AccountAvatar from "../components/Account/AccountAvatar";
import AccountJourney from "../components/Account/AccountJourney";
import MyIssuesTable from "../components/Account/MyIssuesTable";
import UploadRequirements from "../components/Account/UploadRequirements";
import { computeAccountJourney, type JourneyDataset } from "../components/Account/accountJourney";
import { ACCOUNT_TABS, useAccountTab, type AccountTab } from "../components/Account/useAccountTab";
import { useIsMobile } from "../hooks/useIsMobile";
import { useAnalytics } from "../hooks/useAnalytics";
import ProcessingEmailPreference from "../components/ProcessingEmailPreference";

interface DatasetType {
  id: number;
  file_name: string;
  data_access?: "public" | "private" | "viewonly";
  aquisition_year?: number;
  citation_doi?: string;
  freidata_doi?: string;
  current_status?: string;
  is_upload_done?: boolean;
  is_ortho_done?: boolean;
  is_cog_done?: boolean;
  is_thumbnail_done?: boolean;
  is_metadata_done?: boolean;
}

export default function ProfilePage() {
  const { session, user } = useAuth();
  const isMobile = useIsMobile();
  const { track } = useAnalytics("profile");
  const [activeTab, setActiveTab] = useAccountTab();

  const datasets = useUserDatasets();
  const inPublication = useDatasetsInPublication(user?.id);
  const { data: shared } = useSharedWithMe();
  const { data: publications } = useMyPublications(user?.id);
  const { data: flags } = useMyFlags();

  const journey = useMemo(
    () => (datasets.data ? computeAccountJourney(datasets.data as JourneyDataset[], inPublication.data ?? []) : null),
    [datasets.data, inPublication.data],
  );
  const counts: Record<AccountTab, number | undefined> = {
    datasets: datasets.data?.length,
    shared: shared?.length,
    publications: publications?.length,
    issues: flags?.length,
  };

  const [selectedDatasets, setSelectedDatasets] = useState<DatasetType[]>([]);
  const [isPublicationModalVisible, setIsPublicationModalVisible] = useState(false);
  const [resetSelectionFlag, setResetSelectionFlag] = useState(false);

  const showPublicationModal = () => {
    track("publish_started", {
      dataset_count: selectedDatasets.length,
    });
    setIsPublicationModalVisible(true);
  };

  const handlePublicationSuccess = () => {
    setIsPublicationModalVisible(false);
    setResetSelectionFlag(true);
  };

  if (!session) return null;

  if (isMobile) {
    return (
      <div className="min-h-[100dvh] w-full bg-[#F8FAF9] pb-16 pt-24">
        <div className="mx-auto max-w-3xl px-4">
          <div className="mb-3 flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
            <AccountAvatar email={user?.email ?? ""} size={44} />
            <div className="min-w-0">
              <Typography.Title level={5} style={{ margin: 0 }}>
                My Account
              </Typography.Title>
              <Typography.Text className="block truncate text-xs" type="secondary">
                {user?.email}
              </Typography.Text>
            </div>
          </div>

          <div className="mb-4 rounded-lg border border-gray-200 bg-white px-4 py-3">
            <ProcessingEmailPreference userId={user?.id} />
          </div>

          <section aria-label="My datasets">
            <h2 className="mb-1 text-lg font-semibold">My datasets</h2>
            <p className="mb-3 text-xs text-slate-500" data-testid="mobile-desktop-only-note">
              Uploads, publishing and dataset management are available on a desktop browser.
            </p>
            <DataTable />
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full bg-[#F8FAF9] min-h-[100dvh] pb-24 pt-24 md:pt-28">
      <div className="mx-auto max-w-[1920px] px-4 md:px-8 xl:px-12">
        <div className="flex flex-wrap items-center gap-6 pb-8">
          <AccountAvatar email={user?.email ?? ""} size={72} />
          <div className="flex min-w-0 flex-1 flex-col">
            <Typography.Title level={2} style={{ margin: 0, fontWeight: 700 }}>
              My Account
            </Typography.Title>
            <Typography.Text className="text-lg font-medium break-all" type="secondary">
              {user?.email}
            </Typography.Text>
          </div>
          <ProcessingEmailPreference userId={user?.id} />
        </div>
        <AccountJourney steps={journey} failed={datasets.isError && !datasets.data} />
        <div className="w-full">
          <div className="mb-6 flex flex-col gap-3 md:flex-row md:justify-between md:items-center">
            <div className="w-full md:w-auto overflow-x-auto">
              <Segmented
                options={ACCOUNT_TABS.map(({ key, label }) => ({
                  value: key,
                  label: <TabLabel label={label} count={counts[key]} />,
                }))}
                size="large"
                value={activeTab}
                onChange={(value) => setActiveTab(value as AccountTab)}
                className="shadow-sm border border-gray-200/50"
              />
            </div>
            <div className="flex w-full items-center justify-end gap-2 md:w-auto">
              {activeTab === "datasets" ? (
                selectedDatasets.length > 0 ? (
                  <Button size="large" type="primary" icon={<FileOutlined />} onClick={showPublicationModal} className="shadow-sm">
                    Publish Data ({selectedDatasets.length})
                  </Button>
                ) : (
                  <>
                    {/* Accounts without datasets already see the requirements in the getting-started strip. */}
                    {!!counts.datasets && (
                      <Popover title="What you can upload" content={<div className="max-w-sm"><UploadRequirements /></div>} trigger="click" placement="bottomRight">
                        <Button size="large" type="text" icon={<QuestionCircleOutlined />}>
                          What can I upload?
                        </Button>
                      </Popover>
                    )}
                    <UploadButton />
                  </>
                )
              ) : null}
            </div>
          </div>

          <div className="rounded-2xl border border-gray-200/60 bg-white p-6 shadow-sm">
            {activeTab === "datasets" ? (
              <DataTable
                onSelectedRowsChange={setSelectedDatasets}
                resetSelection={resetSelectionFlag}
                onResetSelectionComplete={() => setResetSelectionFlag(false)}
              />
            ) : activeTab === "shared" ? (
              <SharedWithMeTable />
            ) : activeTab === "publications" ? (
              <PublicationsTable onChooseDatasets={() => setActiveTab("datasets")} />
            ) : (
              <MyIssuesTable />
            )}
          </div>

          <PublicationModal
            visible={isPublicationModalVisible}
            onCancel={() => setIsPublicationModalVisible(false)}
            datasets={selectedDatasets}
            onSuccess={handlePublicationSuccess}
          />
        </div>
      </div>
    </div>
  );
}

function TabLabel({ label, count }: { label: string; count?: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span>{label}</span>
      {!!count && (
        <span className="rounded-full bg-slate-200/80 px-2 text-xs font-medium tabular-nums text-slate-600" aria-label={`${count} items`}>
          {count}
        </span>
      )}
    </span>
  );
}
