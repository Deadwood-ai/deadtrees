import { useEffect } from "react";
import { Modal, Form, Checkbox, Select, Radio, Slider, Button, Divider } from "antd";
import { IBiome } from "../types/dataset";
import { useData } from "../hooks/useDataProvider";
import { getBiomeEmoji } from "../utils/biomeDisplay";

interface FilterModalProps {
  isVisible: boolean;
  onClose: () => void;
  onApplyFilters: (filters: AdvancedFilters) => void;
  currentFilters: AdvancedFilters;
}

export interface AdvancedFilters {
  hasDeadwoodPrediction: boolean;
  hasLabels: boolean;
  biome: string | null;
  authors: string[];
  platform: string | null;
  dateRange: [number, number] | null;
}

const FilterModal: React.FC<FilterModalProps> = ({ isVisible, onClose, onApplyFilters, currentFilters }) => {
  const { authors } = useData();
  const [form] = Form.useForm();

  // Determine date range boundaries
  const currentYear = new Date().getFullYear();
  const defaultDateRange: [number, number] = [2010, currentYear];

  // Reset form when modal is opened
  useEffect(() => {
    if (isVisible) {
      const initialValues = {
        hasDeadwoodPrediction: currentFilters.hasDeadwoodPrediction || false,
        hasLabels: currentFilters.hasLabels || false,
        biome: currentFilters.biome || null,
        authors: currentFilters.authors || [],
        platform: currentFilters.platform || "",
        dateRange: currentFilters.dateRange || defaultDateRange,
      };

      form.setFieldsValue(initialValues);
    }
  }, [isVisible, form, currentFilters, defaultDateRange]);

  // Apply filters immediately on any change
  const handleFormChange = (changedValues: Partial<AdvancedFilters>, allValues: AdvancedFilters) => {
    onApplyFilters(allValues);
  };

  const clearFilters = () => {
    const resetFilters: AdvancedFilters = {
      hasDeadwoodPrediction: false,
      hasLabels: false,
      biome: null,
      authors: [],
      platform: "",
      dateRange: defaultDateRange,
    };

    form.setFieldsValue(resetFilters);
    onApplyFilters(resetFilters);
  };

  // Get all Biome options from the enum
  const biomeOptions: Array<{ label: string; value: string }> = Object.values(IBiome).map((value) => ({
    label: `${getBiomeEmoji(value)} ${value}`,
    value: value,
  }));
  biomeOptions.unshift({ label: "All", value: "" });

  return (
    <Modal
      open={isVisible}
      onCancel={onClose}
      footer={null}
      title="Advanced Filters"
      width={600}
      centered
      maskClosable={true}
    >
      <Form
        form={form}
        layout="vertical"
        onValuesChange={handleFormChange}
        initialValues={{
          hasDeadwoodPrediction: false,
          hasLabels: false,
          biome: null,
          authors: [],
          platform: "",
          dateRange: defaultDateRange,
        }}
      >
        <Form.Item className="mb-2" name="hasDeadwoodPrediction" valuePropName="checked">
          <Checkbox>Has Deadwood Prediction</Checkbox>
        </Form.Item>

        {/* <Form.Item className="mb-2" name="hasLabels" valuePropName="checked">
          <Checkbox>Has Labels</Checkbox>
        </Form.Item> */}

        <Divider />

        <Form.Item name="biome" label="Biome">
          <Select placeholder="Select a biome" allowClear options={biomeOptions} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item name="authors" label="Authors">
          <Select
            mode="multiple"
            placeholder="Select authors"
            allowClear
            options={authors}
            style={{ width: "100%" }}
            optionFilterProp="label"
          />
        </Form.Item>

        <Form.Item name="platform" label="Platform">
          <Radio.Group>
            <Radio value="">All</Radio>
            <Radio value="drone">Drone</Radio>
            <Radio value="airborne">Airborne</Radio>
            <Radio value="satellite">Satellite</Radio>
          </Radio.Group>
        </Form.Item>

        <Form.Item name="dateRange" label="Acquisition Date Range">
          <Slider
            range
            min={2010}
            max={currentYear}
            defaultValue={defaultDateRange}
            marks={{
              2010: "2010",
              [currentYear]: currentYear.toString(),
            }}
          />
        </Form.Item>

        <Divider />

        <div className="flex justify-end">
          <Button onClick={clearFilters}>Reset Filters</Button>
        </div>
      </Form>
    </Modal>
  );
};

export default FilterModal;
