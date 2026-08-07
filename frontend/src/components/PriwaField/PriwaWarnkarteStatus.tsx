import { Tag } from "antd";

import { formatPriwaWarnkarteDate } from "./priwaWarnkartePresentation";

interface PriwaWarnkarteStatusProps {
  sourceDate: string | null;
  isPreviewing: boolean;
}

export default function PriwaWarnkarteStatus({
  sourceDate,
  isPreviewing,
}: PriwaWarnkarteStatusProps) {
  const formattedDate = formatPriwaWarnkarteDate(sourceDate);
  if (!formattedDate) return null;

  return (
    <div className="pointer-events-none absolute left-1/2 top-4 z-[60] -translate-x-1/2">
      <Tag color={isPreviewing ? "gold" : "red"} className="m-0 shadow-md">
        {isPreviewing ? "Vorschau · " : ""}Warnkarte vom {formattedDate}
      </Tag>
    </div>
  );
}
