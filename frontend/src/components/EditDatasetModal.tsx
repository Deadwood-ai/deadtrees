import { useState, useEffect } from "react";
import { Modal, Form, Input, Select, Radio, Button, Space, message, Tooltip } from "antd";
import { InfoCircleOutlined } from "@ant-design/icons";

import { useUpdateDatasetMetadata, UpdateDatasetMetadataPayload } from "../hooks/useUpdateDatasetMetadata";
import { useData } from "../hooks/useDataProvider";
import PickerWithType from "./Upload/PickerWithType";
import dayjs, { Dayjs } from "dayjs";

interface Dataset {
  id: number;
  file_name: string;
  authors?: string[] | null;
  aquisition_year?: number;
  aquisition_month?: number;
  aquisition_day?: number;
  platform?: string;
  citation_doi?: string | null;
  additional_information?: string | null;
}

interface EditDatasetModalProps {
  visible: boolean;
  onClose: () => void;
  dataset: Dataset;
}

interface FormValues {
  authors: string[];
  aquisition_date: Dayjs | null;
  platform: string;
  citation_doi: string;
  additional_information: string;
}

const EditDatasetModal: React.FC<EditDatasetModalProps> = ({ visible, onClose, dataset }) => {
  const [form] = Form.useForm<FormValues>();
  const [pickerType, setPickerType] = useState("Year/Month/Day");
  const pickerTypeOptions = ["Year/Month/Day", "Year/Month", "Year"];

  const { mutateAsync: updateMetadata, isPending } = useUpdateDatasetMetadata();
  const { authors: authorOptions } = useData();

  // Initialize form with dataset data when modal opens
  useEffect(() => {
    if (visible && dataset) {
      // Determine the appropriate picker type based on available date fields
      let initialPickerType = "Year";
      let initialDate: Dayjs | null = null;

      if (dataset.aquisition_year) {
        if (dataset.aquisition_day) {
          initialPickerType = "Year/Month/Day";
          initialDate = dayjs()
            .year(dataset.aquisition_year)
            .month((dataset.aquisition_month || 1) - 1)
            .date(dataset.aquisition_day);
        } else if (dataset.aquisition_month) {
          initialPickerType = "Year/Month";
          initialDate = dayjs()
            .year(dataset.aquisition_year)
            .month(dataset.aquisition_month - 1);
        } else {
          initialPickerType = "Year";
          initialDate = dayjs().year(dataset.aquisition_year);
        }
      }

      setPickerType(initialPickerType);

      form.setFieldsValue({
        authors: dataset.authors || [],
        aquisition_date: initialDate,
        platform: dataset.platform || "drone",
        citation_doi: dataset.citation_doi || "",
        additional_information: dataset.additional_information || "",
      });
    }
  }, [visible, dataset, form]);

  const handleSubmit = async (values: FormValues) => {
    try {
      let year: number | undefined;
      let month: number | null = null;
      let day: number | null = null;

      if (values.aquisition_date) {
        year = values.aquisition_date.year();

        if (pickerType === "Year/Month" || pickerType === "Year/Month/Day") {
          month = values.aquisition_date.month() + 1; // dayjs months are 0-based
        }

        if (pickerType === "Year/Month/Day") {
          day = values.aquisition_date.date();
        }
      }

      const payload: UpdateDatasetMetadataPayload = {
        dataset_id: dataset.id,
        authors: values.authors,
        aquisition_year: year,
        aquisition_month: month,
        aquisition_day: day,
        platform: values.platform,
        citation_doi: values.citation_doi || undefined,
        additional_information: values.additional_information || undefined,
      };

      await updateMetadata(payload);

      message.success("Dataset metadata updated successfully");
      onClose();
    } catch (error) {
      console.error("Error updating metadata:", error);
      message.error("Failed to update dataset metadata");
    }
  };

  const handleCancel = () => {
    form.resetFields();
    onClose();
  };

  return (
    <Modal
      title={`Edit Metadata - ${dataset.file_name}`}
      open={visible}
      onCancel={handleCancel}
      footer={null}
      width={800}
      destroyOnClose
    >
      <Form form={form} layout="vertical" onFinish={handleSubmit} variant="filled">
        <Form.Item
          label={
            <div>
              <Tooltip title="Provide the names of individuals or organizations responsible for capturing the orthophoto. Add authors individually - one entry per author.">
                <InfoCircleOutlined className="mr-2" />
              </Tooltip>
              Authors of the Orthophoto
            </div>
          }
          name="authors"
          rules={[
            { required: true, message: "Please enter the authors" },
            {
              validator: (_, value) => {
                if (!value) return Promise.resolve();

                const hasAndPattern = value.some(
                  (author: string) => author.toLowerCase().includes(" and ") || author.toLowerCase().includes(","),
                );

                if (hasAndPattern) {
                  return Promise.reject(
                    'Please add authors individually instead of using "and" or ",". Use separate entries for each author.',
                  );
                }
                return Promise.resolve();
              },
            },
          ]}
        >
          {authorOptions?.at(0)?.label ? (
            <Select
              mode="tags"
              style={{ width: "100%" }}
              options={authorOptions}
              placeholder="Enter author names separately (e.g. 'John Smith')"
            />
          ) : (
            <Select mode="tags" style={{ width: "100%" }} placeholder="Enter authors (one author per entry)" />
          )}
        </Form.Item>

        <Form.Item
          label={
            <div>
              <Tooltip title="Specify the acquisition date of the orthophoto. If you're unsure of the exact date, you can provide a broader timeframe (e.g., month or year).">
                <InfoCircleOutlined className="mr-2" />
              </Tooltip>
              Acquisition Date of the Orthophoto
            </div>
          }
          name="aquisition_date"
          rules={[{ required: true, message: "Please select a date" }]}
          extra="If you're unsure of the exact date, provide a broader timeframe (e.g., month or year)."
        >
          <PickerWithType
            pickerTypeOptions={pickerTypeOptions}
            pickerType={pickerType}
            setPickerType={setPickerType}
            onChange={(date) => form.setFieldsValue({ aquisition_date: date })}
          />
        </Form.Item>

        <Form.Item
          label={
            <div>
              <Tooltip title="Select the platform used for capturing the orthophoto (e.g., Drone, Airborne, or Satellite)">
                <InfoCircleOutlined className="mr-2" />
              </Tooltip>
              Platform
            </div>
          }
          name="platform"
          rules={[{ required: true, message: "Please select a platform" }]}
        >
          <Radio.Group>
            <Radio value="drone">Drone</Radio>
            <Radio value="airborne">Airborne</Radio>
            <Radio value="satellite">Satellite</Radio>
          </Radio.Group>
        </Form.Item>

        <Form.Item
          label="DOI"
          name="citation_doi"
          rules={[
            {
              type: "url",
              message: "Please enter a valid URL",
            },
          ]}
        >
          <Input placeholder="Enter DOI, URL, or publication reference (if applicable)" />
        </Form.Item>

        <Form.Item label="Additional Information" name="additional_information">
          <Input.TextArea
            placeholder="Enter project or data information (e.g., project name, data collection context, processing details)"
            autoSize={{ minRows: 3, maxRows: 6 }}
          />
        </Form.Item>

        <Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" loading={isPending}>
              Save Changes
            </Button>
            <Button onClick={handleCancel}>Cancel</Button>
          </Space>
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default EditDatasetModal;
