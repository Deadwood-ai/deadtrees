import { useState } from "react";
import { Button, Checkbox, DatePicker, Form, List, Modal, Select, Tag, Typography, message } from "antd";
import { DeleteOutlined } from "@ant-design/icons";
import type { Dayjs } from "dayjs";
import type { DatasetAccessRole, IDatasetAccessEntry } from "../../api/datasetAccess";
import { useChangeDatasetAccess, useDatasetAccessRoster } from "../../hooks/useDatasetAccess";
import { ROLE_OPTIONS, roleAlwaysDownloads, roleLabel } from "./accessCopy";
import ShareEmailInput from "./ShareEmailInput";

interface ShareDatasetModalProps {
  datasetId: number | null;
  datasetName?: string;
  onClose: () => void;
}

interface IShareForm {
  email: string;
  role: DatasetAccessRole;
  canDownload: boolean;
  expiresOn?: Dayjs | null;
}

interface IAccessChange {
  role: DatasetAccessRole;
  canDownload: boolean;
}

const formatDate = (value: string) =>
  new Date(value).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });

interface AccessRowProps {
  entry: IDatasetAccessEntry;
  removing: boolean;
  onRemove: () => void;
  onChange: (change: IAccessChange) => void;
}

function AccessRow({ entry, removing, onRemove, onChange }: AccessRowProps) {
  return (
    <List.Item
      actions={
        entry.is_owner
          ? []
          : [<Button key="remove" type="text" danger icon={<DeleteOutlined />} loading={removing} onClick={onRemove} aria-label={`Remove ${entry.email}`} />]
      }
    >
      <List.Item.Meta
        title={<span className="break-all">{entry.email}</span>}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {entry.is_owner ? (
              <Tag color="blue" style={{ margin: 0 }}>
                {roleLabel(entry.role)}
              </Tag>
            ) : (
              <>
                <Select
                  size="small"
                  value={entry.role ?? undefined}
                  onChange={(role: DatasetAccessRole) => onChange({ role, canDownload: entry.can_download })}
                  options={ROLE_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                  popupMatchSelectWidth={false}
                  aria-label={`Access for ${entry.email}`}
                />
                {entry.role === "reader" && (
                  <Checkbox
                    checked={entry.can_download}
                    onChange={(event) => onChange({ role: "reader", canDownload: event.target.checked })}
                  >
                    Can download
                  </Checkbox>
                )}
              </>
            )}
            {entry.expires_at && (
              <span className={entry.is_expired ? "text-red-500" : "text-gray-500"}>
                {entry.is_expired ? "Expired" : "Until"} {formatDate(entry.expires_at)}
              </span>
            )}
          </span>
        }
      />
    </List.Item>
  );
}

/** Add, change and remove the people a dataset is shared with. */
export default function ShareDatasetModal({ datasetId, datasetName, onClose }: ShareDatasetModalProps) {
  const [form] = Form.useForm<IShareForm>();
  const [removingId, setRemovingId] = useState<string | null>(null);
  const open = datasetId !== null;
  const roster = useDatasetAccessRoster(datasetId ?? 0, open);
  const { grant, revoke } = useChangeDatasetAccess(datasetId ?? 0);
  const sharedEmails = new Set((roster.data ?? []).map((entry) => entry.email.toLowerCase()));

  const handleShare = async (values: IShareForm) => {
    try {
      await grant.mutateAsync({
        email: values.email.trim(),
        role: values.role,
        canDownload: values.canDownload,
        expiresAt: values.expiresOn ? values.expiresOn.endOf("day").toISOString() : null,
      });
      message.success(`Shared with ${values.email.trim()}`);
      form.resetFields(["email", "expiresOn"]);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "Could not share the dataset");
    }
  };

  const handleChange = async (entry: IDatasetAccessEntry, change: IAccessChange) => {
    try {
      await grant.mutateAsync({
        email: entry.email,
        role: change.role,
        canDownload: change.canDownload,
        expiresAt: entry.is_expired ? null : entry.expires_at,
      });
      message.success(`Access updated for ${entry.email}`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "Access could not be changed");
    }
  };

  const handleRemove = async (entry: IDatasetAccessEntry) => {
    setRemovingId(entry.user_id);
    try {
      await revoke.mutateAsync(entry.user_id);
      message.success(`${entry.email} no longer has access`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "Access could not be removed");
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <Modal title={datasetName ? `Share ${datasetName}` : "Share dataset"} open={open} onCancel={onClose} footer={null} destroyOnHidden>
      <Typography.Paragraph type="secondary" className="mb-4">
        People need a DeadTrees account; type part of their email to find it. They can then open this dataset from their profile under “Shared with me”.
      </Typography.Paragraph>
      <Typography.Paragraph type="secondary" className="text-xs">
        Anyone who can view a dataset can save the imagery shown in their browser. Download access adds the orthophoto and prediction files.
      </Typography.Paragraph>
      <Form form={form} layout="vertical" initialValues={{ role: "reader", canDownload: false }} onFinish={handleShare} data-testid="share-dataset-form">
        <Form.Item name="email" label="Email" validateTrigger="onBlur" rules={[{ required: true, type: "email", message: "Enter their account email" }]}>
          <ShareEmailInput datasetId={datasetId ?? 0} sharedEmails={sharedEmails} />
        </Form.Item>
        <div className="flex flex-col gap-x-3 sm:flex-row">
          <Form.Item name="role" label="Access" className="sm:flex-1">
            <Select
              options={ROLE_OPTIONS.map((option) => ({
                value: option.value,
                label: option.label,
                title: option.description,
              }))}
            />
          </Form.Item>
          <Form.Item name="expiresOn" label="Until (optional)" className="sm:flex-1">
            <DatePicker className="w-full" disabledDate={(date) => date.isBefore(new Date(), "day")} />
          </Form.Item>
        </div>
        <Form.Item noStyle dependencies={["role"]}>
          {({ getFieldValue }) =>
            roleAlwaysDownloads(getFieldValue("role")) ? null : (
              <Form.Item name="canDownload" valuePropName="checked" className="-mt-2">
                <Checkbox>Can download the orthophoto and predictions</Checkbox>
              </Form.Item>
            )
          }
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={grant.isPending} block>
          Share
        </Button>
      </Form>
      <List
        className="mt-6"
        header={<Typography.Text strong>People with access</Typography.Text>}
        loading={roster.isLoading}
        dataSource={roster.data ?? []}
        rowKey="user_id"
        renderItem={(entry) => (
          <AccessRow
            entry={entry}
            removing={removingId === entry.user_id}
            onRemove={() => handleRemove(entry)}
            onChange={(change) => handleChange(entry, change)}
          />
        )}
      />
    </Modal>
  );
}
