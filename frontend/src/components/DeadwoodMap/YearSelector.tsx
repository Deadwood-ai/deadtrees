import { useMemo } from "react";
import { Segmented, Typography } from "antd";
import { LeftOutlined, RightOutlined } from "@ant-design/icons";

const { Text } = Typography;

interface YearSelectorProps {
  year: string;
  setYear: (year: string) => void;
}

const YEARS = ["2017", "2018", "2019", "2020", "2021", "2022", "2023", "2024", "2025"];

// Memoize options outside component to keep them stable
const YEAR_OPTIONS = YEARS.map((y) => ({ value: y, label: y }));

const YearSelector = ({ year, setYear }: YearSelectorProps) => {
  const currentIndex = YEARS.indexOf(year);
  const isFirst = currentIndex === 0;
  const isLast = currentIndex === YEARS.length - 1;

  const handlePrev = () => {
    if (!isFirst) setYear(YEARS[currentIndex - 1]);
  };

  const handleNext = () => {
    if (!isLast) setYear(YEARS[currentIndex + 1]);
  };

  return (
    <div className="flex items-center gap-2 rounded-lg bg-white/95 px-3 py-2 backdrop-blur-sm">
      <Text type="secondary" className="whitespace-nowrap text-xs font-medium">
        Prediction Year:
      </Text>
      <button
        onClick={handlePrev}
        disabled={isFirst}
        className="flex h-7 w-7 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:text-gray-300"
      >
        <LeftOutlined />
      </button>

      <Segmented size="small" value={year} onChange={(value) => setYear(value as string)} options={YEAR_OPTIONS} />

      <button
        onClick={handleNext}
        disabled={isLast}
        className="flex h-7 w-7 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:text-gray-300"
      >
        <RightOutlined />
      </button>
    </div>
  );
};

export default YearSelector;
