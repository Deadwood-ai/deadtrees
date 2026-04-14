import { Modal, Form, Input, Checkbox, Tooltip, Typography } from "antd";
import { InfoCircleOutlined } from "@ant-design/icons";

interface ReportIssueModalProps {
  open: boolean;
  onCancel: () => void;
  onSubmit: (values: {
    is_ortho_mosaic_issue: boolean;
    is_prediction_issue: boolean;
    description: string;
  }) => Promise<void>;
  isSubmitting: boolean;
}

export default function ReportIssueModal({ open, onCancel, onSubmit, isSubmitting }: ReportIssueModalProps) {
  const [form] = Form.useForm();

  const watchOrtho = Form.useWatch("is_ortho_mosaic_issue", form);
  const watchPred = Form.useWatch("is_prediction_issue", form);
  const watchDesc = Form.useWatch("description", form);
  const canSubmit = !!((watchOrtho || watchPred) && (watchDesc || "").trim().length > 0);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      await onSubmit({
        is_ortho_mosaic_issue: values.is_ortho_mosaic_issue || false,
        is_prediction_issue: values.is_prediction_issue || false,
        description: values.description,
      });
      form.resetFields();
    } catch {
      // Validation errors handled by form
    }
  };

  return (
    <Modal
      title="Report an Issue"
      open={open}
      onCancel={onCancel}
      okText="Submit"
      confirmLoading={isSubmitting}
      okButtonProps={{ disabled: !canSubmit }}
      onOk={handleOk}
    >
      <Form form={form} layout="vertical" initialValues={{ is_ortho_mosaic_issue: false, is_prediction_issue: false }}>
        <div className="mb-2 mt-6 flex items-center">
          <Typography.Text className="text-sm font-medium">Issue type</Typography.Text>
          <Tooltip
            title={
              <div>
                <div>
                  <strong>Orthomosaic</strong>: base image problems (misalignment, seams, black/white borders, color
                  band issues, artifacts).
                </div>
                <div className="mt-1">
                  <strong>Segmentation</strong>: prediction problems (missing deadwood, false positives, poor outlines,
                  misclassification).
                </div>
              </div>
            }
            placement="right"
          >
            <InfoCircleOutlined className="ml-1 text-blue-500" />
          </Tooltip>
        </div>
        <Form.Item className="mb-0" name="is_ortho_mosaic_issue" valuePropName="checked">
          <Checkbox>
            <Tooltip title="Base image problems: misalignment, seams, black/white borders, color band issues, artifacts">
              <span>Orthomosaic issue</span>
            </Tooltip>
          </Checkbox>
        </Form.Item>
        <Form.Item className="mb-4" name="is_prediction_issue" valuePropName="checked">
          <Checkbox>
            <Tooltip title="Segmentation problems: missing deadwood, false positives, poor outlines, obvious misclassification">
              <span>Segmentation issue</span>
            </Tooltip>
          </Checkbox>
        </Form.Item>

        <Form.Item name="description" label="Description" rules={[{ required: true, message: "Please describe the issue" }]}>
          <Input.TextArea
            rows={4}
            placeholder="Describe the issue and where it occurs. Mention Orthomosaic (alignment, seams, borders, bands) or Segmentation (missing, false positives, misclassification)."
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
