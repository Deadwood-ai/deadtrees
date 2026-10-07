import { Radio } from "antd";
import { EyeOutlined, GlobalOutlined, LockOutlined } from "@ant-design/icons";
import { IDataAccess } from "../../types/dataset";
import { VISIBILITY_OPTIONS, VISIBILITY_TRAINING_NOTE } from "./accessCopy";

const ICONS: Record<IDataAccess, React.ReactNode> = {
  [IDataAccess.public]: <GlobalOutlined />,
  [IDataAccess.viewonly]: <EyeOutlined />,
  [IDataAccess.private]: <LockOutlined />,
};

interface VisibilityChoiceProps {
  value?: IDataAccess;
  onChange?: (value: IDataAccess) => void;
  disabled?: boolean;
}

/** Public / View only / Private, each with a one-line explanation. Works as a Form control. */
export default function VisibilityChoice({ value, onChange, disabled }: VisibilityChoiceProps) {
  return (
    <div className="flex w-full flex-col gap-2">
      <Radio.Group
        value={value}
        disabled={disabled}
        onChange={(event) => onChange?.(event.target.value as IDataAccess)}
        className="flex w-full flex-col gap-2"
        data-testid="visibility-choice"
      >
        {VISIBILITY_OPTIONS.map((option) => (
          <Radio key={option.value} value={option.value} className="items-start">
            <span className="flex flex-col">
              <span className="flex items-center gap-2 font-medium text-gray-800">
                {ICONS[option.value]}
                {option.label}
              </span>
              <span className="text-xs text-gray-500">{option.description}</span>
            </span>
          </Radio>
        ))}
      </Radio.Group>
      <span className="text-xs text-gray-500" data-testid="visibility-training-note">
        {VISIBILITY_TRAINING_NOTE}
      </span>
    </div>
  );
}
