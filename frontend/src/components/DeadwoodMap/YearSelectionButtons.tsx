import { Button } from "antd";
import { LeftOutlined, RightOutlined } from "@ant-design/icons";

const YearSelectionButtons = ({
  year,
  setSelectedYear,
}: {
  year: string;
  setSelectedYear: React.Dispatch<React.SetStateAction<string>>;
}) => {
  const years = ["2017", "2018", "2019", "2020", "2021", "2022", "2023", "2024", "2025"];
  const currentIndex = years.indexOf(year);
  const isFirst = currentIndex === 0;
  const isLast = currentIndex === years.length - 1;

  const handlePrev = () => {
    if (!isFirst) {
      setSelectedYear(years[currentIndex - 1]);
    }
  };

  const handleNext = () => {
    if (!isLast) {
      setSelectedYear(years[currentIndex + 1]);
    }
  };

  return (
    <div className="flex items-center justify-center gap-2">
      {/* Min year label */}
      <span className="w-8 text-right text-xs text-gray-300">2017</span>

      {/* Stepper controls */}
      <Button type="text" icon={<LeftOutlined />} onClick={handlePrev} disabled={isFirst} size="small" />
      <span className="min-w-[50px] text-center text-lg font-semibold text-gray-800">{year}</span>
      <Button type="text" icon={<RightOutlined />} onClick={handleNext} disabled={isLast} size="small" />

      {/* Max year label */}
      <span className="w-8 text-left text-xs text-gray-300">2025</span>
    </div>
  );
};

export default YearSelectionButtons;
