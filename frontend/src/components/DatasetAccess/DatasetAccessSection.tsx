import { useState } from "react";
import { Button, Tag, Typography } from "antd";
import { EditOutlined, EyeOutlined, GlobalOutlined, LockOutlined, ShareAltOutlined } from "@ant-design/icons";
import { IDataAccess, type IDataset } from "../../types/dataset";
import { useMyDatasetAccess } from "../../hooks/useDatasetAccess";
import { useCanViewAllPrivate } from "../../hooks/useUserPrivileges";
import ChangeVisibilityModal from "./ChangeVisibilityModal";
import EditDatasetModal from "../EditDatasetModal";
import ShareDatasetModal from "./ShareDatasetModal";
import { roleLabel, visibilityLabel } from "./accessCopy";

const VISIBILITY_TAGS: Record<IDataAccess, { color: string; icon: React.ReactNode }> = {
  [IDataAccess.public]: { color: "green", icon: <GlobalOutlined /> },
  [IDataAccess.viewonly]: { color: "orange", icon: <EyeOutlined /> },
  [IDataAccess.private]: { color: "red", icon: <LockOutlined /> },
};

/**
 * Visibility and sharing for one dataset, shown to people with a stake in it:
 * the owner, people it is shared with and operators who can see private data.
 */
export default function DatasetAccessSection({ dataset }: { dataset: IDataset }) {
  const { data: access } = useMyDatasetAccess(dataset.id);
  const { canView: canViewAllPrivate } = useCanViewAllPrivate();
  const [sharing, setSharing] = useState(false);
  const [changingVisibility, setChangingVisibility] = useState(false);
  const [editing, setEditing] = useState(false);

  if (!access || !(access.is_owner || access.role || access.can_manage_access || canViewAllPrivate)) return null;
  const tag = VISIBILITY_TAGS[dataset.data_access] ?? VISIBILITY_TAGS[IDataAccess.public];

  return (
    <div className="rounded-2xl border border-gray-200/60 bg-white p-5 shadow-sm space-y-3" data-testid="dataset-access-section">
      <div className="flex items-center justify-between gap-4">
        <Typography.Text className="text-gray-600">Visibility</Typography.Text>
        <Tag icon={tag.icon} color={tag.color} style={{ margin: 0 }}>
          {visibilityLabel(dataset.data_access)}
        </Tag>
      </div>
      {access.role && (
        <div className="flex items-center justify-between gap-4">
          <Typography.Text className="text-gray-600">Shared with you</Typography.Text>
          <Typography.Text strong>
            {roleLabel(access.role)}
            {access.expires_at && ` until ${new Date(access.expires_at).toLocaleDateString("en-US")}`}
          </Typography.Text>
        </div>
      )}
      {(access.can_manage_access || access.can_edit_details || access.is_owner) && (
        <div className="flex flex-wrap gap-2 pt-1">
          {access.can_edit_details && (
            <Button icon={<EditOutlined />} onClick={() => setEditing(true)}>
              Edit details
            </Button>
          )}
          {access.can_manage_access && (
            <Button icon={<ShareAltOutlined />} onClick={() => setSharing(true)}>
              Share
            </Button>
          )}
          {access.is_owner && <Button onClick={() => setChangingVisibility(true)}>Change visibility</Button>}
        </div>
      )}
      <ShareDatasetModal
        datasetId={sharing ? dataset.id : null}
        datasetName={dataset.file_name}
        onClose={() => setSharing(false)}
      />
      <EditDatasetModal visible={editing} onClose={() => setEditing(false)} dataset={dataset} />
      <ChangeVisibilityModal
        datasetId={changingVisibility ? dataset.id : null}
        current={dataset.data_access}
        onClose={() => setChangingVisibility(false)}
      />
    </div>
  );
}
