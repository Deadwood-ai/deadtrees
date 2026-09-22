import { Form, Input, Tooltip } from "antd";
import { InfoCircleOutlined } from "@ant-design/icons";

/**
 * The "Additional Information" field, shared by the upload form and the
 * dataset edit modal.
 *
 * Data providers know their own sites far better than our auditors do, so the
 * field asks them directly for the context that decides hard audit cases:
 * season, whether leafless crowns are dead or merely bare, and where mortality
 * is expected. Whatever they write is shown to auditors in the audit sidebar.
 */
const HINT_POINTS = [
  "Was the imagery taken in-season (leaf-on)?",
  "If trees appear leafless in this orthophoto, are they dead — or just seasonally bare?",
  "Do you expect tree mortality or canopy degradation at this site, and roughly where?",
];

const PLACEHOLDER =
  "Project or data information, and what you know about the site (e.g. 'Leaf-on, flown in the rainy season. The leafless trees in the north are dead, not deciduous.')";

const AdditionalInformationFormItem: React.FC = () => (
  <Form.Item
    label={
      <div>
        <Tooltip title="Anything you know about the site helps our auditors judge the AI predictions for this dataset.">
          <InfoCircleOutlined className="mr-2" />
        </Tooltip>
        Additional Information
      </div>
    }
    name="additional_information"
    extra={
      <div>
        You know your site best. Please tell us, so our auditors can judge the AI predictions:
        <ul className="mb-0 mt-1 list-disc pl-5">
          {HINT_POINTS.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
      </div>
    }
  >
    <Input.TextArea placeholder={PLACEHOLDER} autoSize={{ minRows: 3, maxRows: 8 }} />
  </Form.Item>
);

export default AdditionalInformationFormItem;
