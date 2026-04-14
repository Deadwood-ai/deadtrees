import { DatePicker, Select, Space } from "antd";
import { Dayjs } from "dayjs";

interface PickerWithTypeProps {
  value?: Dayjs | null;
  onChange: (date: Dayjs | null) => void;
  pickerTypeOptions: string[];
  pickerType: string;
  setPickerType: (type: string) => void;
}

const pickerTypeToAntdPicker: Record<string, "date" | "month" | "year"> = {
  "Year/Month/Day": "date",
  "Year/Month": "month",
  Year: "year",
} as const;

const PickerWithType = ({ value, onChange, pickerTypeOptions, pickerType, setPickerType }: PickerWithTypeProps) => {
  const handleDateChange = (date: Dayjs | null) => {
    if (date) {
      // Normalize the date based on picker type
      let normalizedDate: Dayjs | null = date;

      switch (pickerType) {
        case "Year":
          // Set to January 1st of selected year
          normalizedDate = date.startOf("year");
          break;
        case "Year/Month":
          // Set to first day of selected month
          normalizedDate = date.startOf("month");
          break;
        case "Year/Month/Day":
          // Keep the full date
          normalizedDate = date;
          break;
      }
      onChange(normalizedDate);
    } else {
      onChange(null);
    }
  };

  return (
    <div className="flex w-full space-x-4">
      <Select
        style={{ width: "100%" }}
        value={pickerType}
        onChange={(newType) => {
          setPickerType(newType);
          // Reset date when changing picker type
          onChange(null);
        }}
      >
        {pickerTypeOptions.map((option) => (
          <Select.Option key={option} value={option}>
            {option}
          </Select.Option>
        ))}
      </Select>
      <DatePicker
        className="w-full"
        picker={pickerTypeToAntdPicker[pickerType]}
        onChange={handleDateChange}
        value={value}
        // Format the display based on picker type
        format={pickerType === "Year" ? "YYYY" : pickerType === "Year/Month" ? "YYYY-MM" : "YYYY-MM-DD"}
      />
    </div>
  );
};

export default PickerWithType;
