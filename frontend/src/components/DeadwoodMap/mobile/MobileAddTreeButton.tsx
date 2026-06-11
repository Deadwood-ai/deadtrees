import { Button } from "antd";
import { PlusOutlined } from "@ant-design/icons";

interface MobileAddTreeButtonProps {
  hidden?: boolean;
  onClick: () => void;
}

const MobileAddTreeButton = ({
  hidden = false,
  onClick,
}: MobileAddTreeButtonProps) => {
  if (hidden) return null;

  return (
    <div className="pointer-events-none absolute bottom-[calc(1rem+env(safe-area-inset-bottom))] right-3 z-[54] md:hidden">
      <Button
        type="primary"
        shape="round"
        size="middle"
        icon={<PlusOutlined />}
        className="pointer-events-auto !flex !h-11 !items-center !px-4 text-sm font-semibold shadow-lg shadow-emerald-950/20"
        aria-label="Add dead tree observation"
        onClick={onClick}
      >
        Add
      </Button>
    </div>
  );
};

export default MobileAddTreeButton;
