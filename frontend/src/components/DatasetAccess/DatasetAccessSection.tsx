import { Tag, Typography } from "antd";
import { EyeOutlined, GlobalOutlined, LockOutlined } from "@ant-design/icons";
import { Link } from "react-router-dom";
import { IDataAccess, type IDataset } from "../../types/dataset";
import { useMyDatasetAccess } from "../../hooks/useDatasetAccess";
import { useCanViewAllPrivate } from "../../hooks/useUserPrivileges";
import { datasetAccountLink, roleLabel, visibilityLabel } from "./accessCopy";

const VISIBILITY_TAGS: Record<IDataAccess, { color: string; icon: React.ReactNode }> = {
  [IDataAccess.public]: { color: "green", icon: <GlobalOutlined /> },
  [IDataAccess.viewonly]: { color: "orange", icon: <EyeOutlined /> },
  [IDataAccess.private]: { color: "red", icon: <LockOutlined /> },
};

/**
 * Who can see one dataset, shown to people with a stake in it: the owner, people it
 * is shared with and operators who can see private data. It only informs; details
 * and sharing are managed from the account page.
 */
export default function DatasetAccessSection({ dataset }: { dataset: IDataset }) {
  const { data: access } = useMyDatasetAccess(dataset.id);
  const { canView: canViewAllPrivate } = useCanViewAllPrivate();

  if (!access || !(access.is_owner || access.role || access.can_manage_access || canViewAllPrivate)) return null;
  const tag = VISIBILITY_TAGS[dataset.data_access] ?? VISIBILITY_TAGS[IDataAccess.public];
  const accountLink = datasetAccountLink(access, dataset);

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
      {accountLink && (
        <div>
          <Link to={accountLink.to}>{accountLink.label}</Link>
        </div>
      )}
    </div>
  );
}
