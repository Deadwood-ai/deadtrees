import { Typography, Tag } from "antd";
import {
  EditOutlined,
  InfoCircleOutlined,
  QuestionCircleOutlined,
  BulbOutlined,
  HighlightOutlined,
  ScissorOutlined,
  DeleteOutlined,
  UndoOutlined,
} from "@ant-design/icons";
import type { LayerType } from "../../hooks/useSaveCorrections";

interface EditingSidebarProps {
  layerType: LayerType;
}

export default function EditingSidebar({ layerType }: EditingSidebarProps) {
  const layerName = layerType === "deadwood" ? "Deadwood" : "Forest Cover";

  return (
    <div className="p-2">
      {/* Editing Header */}
      <div className="mb-4 rounded-lg bg-blue-50 p-4">
        <div className="mb-2 flex items-center gap-2">
          <EditOutlined className="text-xl text-blue-600" />
          <Typography.Title level={5} className="m-0 text-blue-800">
            Editing {layerName}
          </Typography.Title>
        </div>
        <Typography.Text type="secondary" className="text-xs">
          Help improve predictions by correcting polygon boundaries
        </Typography.Text>
      </div>

      {/* Tools Section */}
      <div className="mb-4 rounded-md bg-white p-4">
        <Typography.Text strong className="mb-3 block text-gray-700">
          <BulbOutlined className="mr-2" />
          Available Tools
        </Typography.Text>
        <div className="space-y-2 text-xs text-gray-600">
          <div className="flex items-start gap-2">
            <HighlightOutlined className="mt-0.5 text-blue-500" />
            <div>
              <div className="font-medium">Draw Polygon</div>
              <div className="text-gray-400">Click to add new polygon boundaries</div>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <ScissorOutlined className="mt-0.5 text-blue-500" />
            <div>
              <div className="font-medium">Cut / Merge / Clip</div>
              <div className="text-gray-400">Select 2 polygons to modify</div>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <DeleteOutlined className="mt-0.5 text-red-500" />
            <div>
              <div className="font-medium">Delete</div>
              <div className="text-gray-400">Remove incorrect polygons</div>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <UndoOutlined className="mt-0.5 text-gray-500" />
            <div>
              <div className="font-medium">Undo</div>
              <div className="text-gray-400">Revert last action</div>
            </div>
          </div>
        </div>
      </div>

      {/* Keyboard Shortcuts */}
      <div className="mb-4 rounded-md bg-white p-4">
        <Typography.Text strong className="mb-3 block text-gray-700">
          <QuestionCircleOutlined className="mr-2" />
          Keyboard Shortcuts
        </Typography.Text>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="flex items-center gap-2">
            <Tag className="m-0 font-mono text-[10px]">A</Tag>
            <span className="text-gray-600">Draw mode</span>
          </div>
          <div className="flex items-center gap-2">
            <Tag className="m-0 font-mono text-[10px]">D</Tag>
            <span className="text-gray-600">Delete</span>
          </div>
          <div className="flex items-center gap-2">
            <Tag className="m-0 font-mono text-[10px]">G</Tag>
            <span className="text-gray-600">Merge</span>
          </div>
          <div className="flex items-center gap-2">
            <Tag className="m-0 font-mono text-[10px]">X</Tag>
            <span className="text-gray-600">Clip</span>
          </div>
          <div className="flex items-center gap-2">
            <Tag className="m-0 font-mono text-[10px]">C</Tag>
            <span className="text-gray-600">Cut hole</span>
          </div>
          <div className="flex items-center gap-2">
            <Tag className="m-0 font-mono text-[10px]">⌘Z</Tag>
            <span className="text-gray-600">Undo</span>
          </div>
          <div className="flex items-center gap-2">
            <Tag className="m-0 font-mono text-[10px]">S</Tag>
            <span className="text-gray-600">AI assist</span>
          </div>
          <div className="flex items-center gap-2">
            <Tag className="m-0 font-mono text-[10px]">Esc</Tag>
            <span className="text-gray-600">Cancel</span>
          </div>
        </div>
      </div>

      {/* Tips */}
      <div className="rounded-md bg-amber-50 p-4">
        <Typography.Text strong className="mb-2 block text-amber-800">
          <InfoCircleOutlined className="mr-2" />
          Tips
        </Typography.Text>
        <ul className="m-0 list-inside list-disc space-y-1 pl-0 text-xs text-amber-700">
          <li>Click on polygons to select them</li>
          <li>Hold Shift to select multiple polygons</li>
          <li>Use AI assist (S) to auto-detect boundaries</li>
          <li>Remember to save your changes</li>
        </ul>
      </div>
    </div>
  );
}
