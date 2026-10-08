import { useEffect, useState } from "react";
import { Alert, Modal, message } from "antd";
import { IDataAccess } from "../../types/dataset";
import { useUpdateDatasetVisibility } from "../../hooks/useDatasetAccess";
import VisibilityChoice from "./VisibilityChoice";
import { visibilityLabel, visibilityReductionNotice } from "./accessCopy";

interface ChangeVisibilityModalProps {
  datasetId: number | null;
  current: IDataAccess | null;
  onClose: () => void;
}

/** Owner dialog to switch between Public, View only and Private. */
export default function ChangeVisibilityModal({ datasetId, current, onClose }: ChangeVisibilityModalProps) {
  const [value, setValue] = useState<IDataAccess | undefined>(current ?? undefined);
  const update = useUpdateDatasetVisibility();
  const reductionNotice = visibilityReductionNotice(current, value);

  useEffect(() => setValue(current ?? undefined), [current, datasetId]);

  const handleSave = async () => {
    if (!datasetId || !value || value === current) return onClose();
    try {
      await update.mutateAsync({ datasetId, dataAccess: value });
      message.success(`Dataset is now ${visibilityLabel(value).toLowerCase()}`);
      onClose();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "Visibility could not be changed");
    }
  };

  return (
    <Modal
      title="Who can see this dataset?"
      open={datasetId !== null}
      onCancel={onClose}
      onOk={handleSave}
      okText="Save"
      confirmLoading={update.isPending}
      okButtonProps={{ disabled: !value || value === current }}
      destroyOnHidden
    >
      <div className="flex flex-col gap-4 py-2">
        <VisibilityChoice value={value} onChange={setValue} />
        {reductionNotice && (
          <Alert type="warning" showIcon message={reductionNotice} data-testid="visibility-reduction-notice" />
        )}
      </div>
    </Modal>
  );
}
