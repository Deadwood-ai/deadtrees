import { Tooltip, Typography } from "antd";
import { ClockCircleOutlined } from "@ant-design/icons";

interface InfoRowProps {
  label: string;
  children: React.ReactNode;
  tooltip?: string;
}

/** A label and its value on one line, as the dataset page and the dataset status panel show them.
 * The tooltip explains the row and sits on its label, so controls in the value keep their own. */
export const InfoRow = ({ label, children, tooltip }: InfoRowProps) => {
  const labelText = (
    <Typography.Text className={`text-gray-600 shrink-0 ${tooltip ? "cursor-help underline decoration-dotted decoration-gray-300 underline-offset-4" : ""}`}>
      {label}
    </Typography.Text>
  );
  return (
    <div className="flex justify-between items-center gap-4 rounded hover:bg-black/5 transition-colors px-1 -mx-1">
      {tooltip ? (
        <Tooltip title={tooltip} placement="topLeft">
          {labelText}
        </Tooltip>
      ) : (
        labelText
      )}
      <div className="text-right min-w-0">{children}</div>
    </div>
  );
};

/** An audit finding not there yet: the check has not run, or a person still has to look at it. */
export const Pending = () => (
  <span className="inline-flex items-center gap-1.5 text-gray-500">
    <ClockCircleOutlined className="animate-pulse" />
    Pending
  </span>
);
