import { Button, Drawer } from "antd";
import {
  AreaChartOutlined,
  FlagOutlined,
  LoginOutlined,
} from "@ant-design/icons";

import { mobileMapThumbnails } from "./mobileMapThumbnails";

interface MobileAnalysisDrawerProps {
  open: boolean;
  isDrawingPolygon: boolean;
  isDrawingFlag: boolean;
  isLoggedIn: boolean;
  onClose: () => void;
  onAnalyzeClick: () => void;
  onFlagClick: () => void;
  onLoginRequired: () => void;
}

const MobileAnalysisDrawer = ({
  open,
  isDrawingPolygon,
  isDrawingFlag,
  isLoggedIn,
  onClose,
  onAnalyzeClick,
  onFlagClick,
  onLoginRequired,
}: MobileAnalysisDrawerProps) => (
  <Drawer
    title="Analyze"
    placement="bottom"
    height="auto"
    open={open}
    onClose={onClose}
    className="md:hidden"
    rootClassName="deadtrees-mobile-control-panel"
    styles={{
      header: { padding: "14px 16px" },
      body: { padding: "4px 16px 20px" },
    }}
  >
    <div className="space-y-3">
      <div className="w-full overflow-hidden rounded-2xl border border-slate-200 bg-white text-left shadow-sm">
        <img
          src={mobileMapThumbnails.analysis}
          alt=""
          className="h-28 w-full object-cover"
          aria-hidden="true"
        />
        <div className="p-3">
          <div className="text-sm font-semibold text-slate-950">
            Area statistics
          </div>
          <div className="mt-1 text-xs leading-5 text-slate-500">
            Draw an area to calculate tree cover and standing deadwood values.
          </div>
          <Button
            block
            type={isDrawingPolygon ? "primary" : "default"}
            icon={<AreaChartOutlined />}
            className="mt-3"
            onClick={onAnalyzeClick}
          >
            {isDrawingPolygon ? "Cancel analysis" : "Start analysis"}
          </Button>
        </div>
      </div>

      {isLoggedIn ? (
        <Button
          block
          icon={<FlagOutlined />}
          type={isDrawingFlag ? "primary" : "default"}
          danger={isDrawingFlag}
          onClick={onFlagClick}
        >
          {isDrawingFlag ? "Cancel flag" : "Flag an issue"}
        </Button>
      ) : (
        <Button block icon={<LoginOutlined />} onClick={onLoginRequired}>
          Sign in to flag an issue
        </Button>
      )}
    </div>
  </Drawer>
);

export default MobileAnalysisDrawer;
