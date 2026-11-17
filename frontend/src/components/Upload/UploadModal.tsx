import { useEffect, useState } from "react";
import {
  Button,
  Form,
  Radio,
  Space,
  Upload,
  Modal,
  Alert,
  Input,
  Select,
  Tooltip,
  Checkbox,
  Typography,
  message,
} from "antd";
import { InfoCircleOutlined, InboxOutlined } from "@ant-design/icons";
import { usePriwaProjectMemberships } from "../../hooks/usePriwaProjectMemberships";
import { IDataAccess, ILicense, IPlatform, UploadType } from "../../types/dataset";
import { useFileUpload } from "../../hooks/useFileUpload";
import { useResumableUpload } from "../../hooks/useResumableUpload";
import PickerWithType from "./PickerWithType";
import type { UploadMetadata } from "../../api/uploadOrtho";
import { processingStepsFor } from "../../utils/uploadProcessingSteps";
import { useData } from "../../hooks/useDataProvider";
import { findDuplicateUpload } from "../../api/duplicateUpload";
import VisibilityChoice from "../DatasetAccess/VisibilityChoice";
import {
  detectUploadType,
  validateFileSize,
  validateGeoTiffUpload,
  validateZipUpload,
} from "../../utils/fileValidation";
import AdditionalInformationFormItem from "../AdditionalInformationFormItem";

import { RcFile } from "antd/es/upload";
import type { Dayjs } from "dayjs";
import { useAnalytics } from "../../hooks/useAnalytics";
import { Link } from "react-router-dom";
// New interfaces
interface IFormValues {
  license: ILicense;
  platform: IPlatform;
  spectral_properties: string;
  aquisition_date: Dayjs | null;
  author: string[];
  doi: string;
  additional_information: string;
  data_access: IDataAccess;
}

interface UploadModalProps {
  isVisible: boolean;
  onClose: () => void;
  uploadKey: string;
}


const TermsLink = () => (
  <Typography.Link href="/terms-of-service" target="_blank">
    terms of service
  </Typography.Link>
);

const PrivacyLink = () => (
  <Typography.Link href="/datenschutzerklaerung" target="_blank">
    privacy policy
  </Typography.Link>
);

const DuplicateUploadNotice = ({ datasetId }: { datasetId: number | null }) => (
  <span data-testid="upload-duplicate-notice">
    {datasetId === null ? (
      "This file has already been uploaded to deadtrees.earth."
    ) : (
      <>
        This file is already on deadtrees.earth as{" "}
        <Link to={`/dataset/${datasetId}`} target="_blank" rel="noopener noreferrer">
          dataset {datasetId}
        </Link>
        .
      </>
    )}{" "}
    If that dataset failed processing, contact <a href="mailto:info@deadtrees.earth">info@deadtrees.earth</a> and we
    will rerun it. If you believe this is a different file, contact us as well.
  </span>
);

const UploadModal: React.FC<UploadModalProps> = ({ isVisible, onClose, uploadKey }) => {
  const pickerTypeOptions = ["Year/Month/Day", "Year/Month", "Year"];
  const [form] = Form.useForm();
  const agreementAccepted = Form.useWatch("agreement", form);
  const dataAccess = Form.useWatch("data_access", form);
  const platform = Form.useWatch("platform", form);
  const { data: priwaMemberships = [] } = usePriwaProjectMemberships();
  // Caches written before the flag was read lack it; the database default is to contribute.
  const priwaProject = priwaMemberships.find((membership) => membership.contributesFlights !== false);

  // PRIWA partners' flights stay inside their project unless they choose otherwise.
  useEffect(() => {
    if (priwaProject && !form.isFieldTouched("data_access")) {
      form.setFieldValue("data_access", IDataAccess.private);
    }
  }, [priwaProject, form]);

  const { fileList, onFileChange, beforeUpload } = useFileUpload();

  const [pickerType, setPickerType] = useState(pickerTypeOptions[0]);

  const { authors } = useData();
  // console.log("authors in upload modal", authors);

  const [uploadValidationError, setUploadValidationError] = useState<React.ReactNode>(null);
  const [uploadValidationWarnings, setUploadValidationWarnings] = useState<string[]>([]);
  const { track } = useAnalytics("profile");
  const runUpload = useResumableUpload("profile");


  const handleBeforeUpload = async (file: RcFile) => {
    try {
      const uploadType = detectUploadType(file.name);
      validateFileSize(file, uploadType);
      const warnings =
        uploadType === UploadType.RAW_IMAGES_ZIP ? await validateZipUpload(file) : await validateGeoTiffUpload(file);

      const duplicate = await findDuplicateUpload(file);
      if (duplicate) {
        setUploadValidationError(<DuplicateUploadNotice datasetId={duplicate.datasetId} />);
        setUploadValidationWarnings([]);
        message.error("File could not be added. See the details below the file picker.");
        return Upload.LIST_IGNORE;
      }

      setUploadValidationError(null);
      setUploadValidationWarnings(warnings);
      return beforeUpload(file, []);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "File validation failed. Please choose a different file.";
      setUploadValidationError(errorMessage);
      setUploadValidationWarnings([]);
      message.error("File could not be added. See the details below the file picker.");
      return Upload.LIST_IGNORE;
    }
  };

  const handleUpload = async (values: IFormValues) => {
    const uploadFile = fileList[0]?.originFileObj;
    if (!uploadFile) {
      message.error("No file selected for upload.");
      return;
    }
    const uploadType = detectUploadType(uploadFile.name);
    try {
      validateFileSize(uploadFile, uploadType);
      if (uploadType === UploadType.GEOTIFF) {
        await validateGeoTiffUpload(uploadFile);
      }
    } catch (error) {
      track("upload_failed", {
        upload_type: uploadType,
        failure_reason: error instanceof Error ? error.message : "unknown_error",
      });
      message.error(error instanceof Error ? error.message : "File validation failed.");
      return;
    }

    const metadata: UploadMetadata = {
      // Every contribution is published under CC BY; the form has no license choice.
      license: "CC BY",
      platform: String(values.platform),
      authors: values.author,
      upload_type: uploadType,
      aquisition_year: values.aquisition_date?.year(),
      aquisition_month: values.aquisition_date ? values.aquisition_date.month() + 1 : undefined,
      aquisition_day: values.aquisition_date?.date(),
      additional_information: values.additional_information,
      data_access: values.data_access,
      citation_doi: values.doi,
    };

    await runUpload({
      file: uploadFile,
      uploadId: uploadKey,
      metadata,
      uploadType,
      processingSteps: processingStepsFor(uploadType),
    });
  };

  const onFormFinish = (values: IFormValues) => {
    onClose(); // Close the modal immediately
    handleUpload(values); // Start the upload process
  };

  const handleModalClose = () => {
    setUploadValidationError(null);
    setUploadValidationWarnings([]);
    onClose();
  };

  return (
    <Modal
      open={isVisible}
      centered
      onCancel={handleModalClose}
      footer={null}
      style={{ padding: 0, margin: 0 }}
      maskClosable={false}
      width={720}
    >
      <div className="m-0 px-4 py-0" data-testid="contributor-upload-modal">
        <Typography.Title style={{ margin: 0, paddingBottom: 16 }} level={4}>
          Orthophoto Upload
        </Typography.Title>
        <Form
          layout="vertical"
          onFinish={onFormFinish}
          initialValues={{ platform: "drone", agreement: false, data_access: IDataAccess.public }}
          variant="filled"
          form={form}
        >
          <div className="flex flex-col w-full gap-1">
            <Form.Item label="Orthophoto" rules={[{ required: true, message: "Please upload a GeoTIFF file" }]}>
              <Upload.Dragger
                data-testid="contributor-upload-dropzone"
                fileList={fileList}
                onChange={onFileChange}
                beforeUpload={handleBeforeUpload}
                accept=".tif,.tiff,.zip"
                maxCount={1}
                className="w-full"
              >
                <div className="flex">
                  <p className="ant-upload-drag-icon px-8">
                    <InboxOutlined />
                  </p>
                  <div className="text-start">
                    <p className="ant-upload-text mb-0">Click or drag file to this area</p>
                    <p className="ant-upload-hint mb-0 text-xs">
                      GeoTIFF (.tif, .tiff) max 20GB or ZIP with raw drone images (.zip) max 30GB, orthomosaic
                      processing. For raw images, see the{" "}
                      <Link
                        to="/releases/drone-mapping-guide"
                        onClick={(event) => event.stopPropagation()}
                      >
                        drone mapping guide
                      </Link>
                      .
                    </p>
                  </div>
                </div>
              </Upload.Dragger>
            </Form.Item>
            {uploadValidationError ? (
              <Alert
                type="error"
                showIcon
                message="File could not be added"
                description={uploadValidationError}
                className="mb-3"
              />
            ) : null}
            {fileList.length > 0 && uploadValidationWarnings.length > 0 ? (
              <Alert
                data-testid="upload-validation-warning"
                type="warning"
                showIcon
                message="This upload may not process"
                description={
                  <ul className="mb-0 pl-4">
                    {uploadValidationWarnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                }
                className="mb-3"
              />
            ) : null}

            <Form.Item
              rules={[
                { required: true, message: "Please enter the authors" },
                {
                  validator: (_, value) => {
                    if (!value) return Promise.resolve();
                    const hasAndPattern = value.some(
                      (author: string) =>
                        author.toLowerCase().includes(" and ") || author.toLowerCase().includes(","),
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
              label={
                <div>
                  <Tooltip title="Provide the names of individuals or organizations responsible for capturing the orthophoto. Add authors individually - one entry per author.">
                    <InfoCircleOutlined className="mr-2" />
                  </Tooltip>
                  Authors of the Orthophoto
                </div>
              }
              name="author"
            >
              {authors?.at(0)?.label ? (
                <Select
                  data-testid="contributor-upload-author-select"
                  mode="tags"
                  style={{ width: "100%" }}
                  options={authors}
                  placeholder="Enter author names separately (e.g. 'John Smith')"
                />
              ) : (
                <Select
                  data-testid="contributor-upload-author-select"
                  mode="tags"
                  style={{ width: "100%" }}
                  placeholder="Enter authors (one author per entry)"
                />
              )}
            </Form.Item>

            <Form.Item
              className="mb-1 w-full"
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
                datePickerTestId="contributor-upload-acquisition-date"
                pickerTypeTestId="contributor-upload-acquisition-date-type"
              />
            </Form.Item>

            <Form.Item
              label={
                <div>
                  <Tooltip title="Select the platform used for capturing the orthophoto (Drone or Airborne). Satellite imagery is not supported in this upload.">
                    <InfoCircleOutlined className="mr-2" />
                  </Tooltip>
                  Platform
                </div>
              }
              name="platform"
            >
              <Radio.Group>
                <Radio value="drone">Drone</Radio>
                <Radio value="airborne">Airborne</Radio>
              </Radio.Group>
            </Form.Item>

            <Form.Item
              label="DOI"
              name="doi"
              rules={[
                {
                  type: "url",
                  message: "Please enter a valid URL",
                },
              ]}
            >
              <Input placeholder="Enter DOI, URL, or publication reference (if applicable)" />
            </Form.Item>

            <AdditionalInformationFormItem />

            <Form.Item name="data_access" label="Who can see this dataset?" className="mt-2">
              <VisibilityChoice />
            </Form.Item>
            {priwaProject && platform === "drone" && dataAccess === IDataAccess.private && (
              <Alert
                type="info"
                showIcon
                className="-mt-2 mb-4"
                data-testid="upload-priwa-private-notice"
                message="Your PRIWA project colleagues can still view this flight in the PRIWA app."
              />
            )}

            <Form.Item>
              <div className="space-y-4">
                <Form.Item
                  name="agreement"
                  valuePropName="checked"
                  className="mb-0"
                  rules={[
                    {
                      validator: (_, value) =>
                        value
                          ? Promise.resolve()
                          : Promise.reject("Please accept the terms of service and privacy policy"),
                    },
                  ]}
                >
                  <Checkbox className="mt-1 leading-relaxed">
                    <span className="text-sm text-gray-700">
                      I agree to the <TermsLink /> and <PrivacyLink /> and confirm that I have the rights to share this
                      data. Public data is shared under CC BY 4.0.
                      <span className="ml-1 font-medium text-red-600">(required)</span>
                    </span>
                  </Checkbox>
                </Form.Item>
                <Space className="pt-2">
                  <Button
                    data-testid="contributor-upload-submit"
                    type="primary"
                    htmlType="submit"
                    disabled={fileList.length === 0 || !agreementAccepted}
                  >
                    Upload
                  </Button>
                  <Button type="default" onClick={onClose}>
                    Cancel
                  </Button>
                </Space>
              </div>
            </Form.Item>
          </div>
        </Form>
      </div>
    </Modal>
  );
};

export default UploadModal;
