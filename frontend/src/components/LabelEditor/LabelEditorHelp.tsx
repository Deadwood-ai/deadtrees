import { Button } from "antd";
import { CloseOutlined, QuestionCircleOutlined } from "@ant-design/icons";

const EXPLORE_KEYS: [string, string][] = [
  ["1", "Imagery only"],
  ["2", "Deadwood"],
  ["3", "Tree cover"],
  ["4", "Both layers"],
  ["Space", "Hold to hide labels"],
  ["E", "Edit the layer you see"],
  ["Click", "Inspect a polygon"],
  ["I", "Show or hide this help"],
];

const EDIT_KEYS: [string, string][] = [
  ["2 / 3", "Edit deadwood / tree cover"],
  ["Space", "Hold to hide labels"],
  ["S", "AI outline (box, then clicks)"],
  ["A", "Draw a polygon"],
  ["Q / E", "Add / remove an area"],
  ["F", "Find in area"],
  ["T", "Copy selection to the other layer"],
  ["D", "Delete selection"],
  ["G / X / C", "Merge / clip / cut hole"],
  ["Ctrl Z", "Undo"],
  ["Ctrl S", "Save and go back to exploring"],
];

interface LabelEditorHelpProps {
  collapsed: boolean;
  onToggle: () => void;
  isEditing: boolean;
}

/** Keyboard help of the label editor; folds into a "Help (I)" button. */
export default function LabelEditorHelp({ collapsed, onToggle, isEditing }: LabelEditorHelpProps) {
  if (collapsed) {
    return (
      <Button icon={<QuestionCircleOutlined />} onClick={onToggle} className="shadow-md" title="Show help (I)">
        Help (I)
      </Button>
    );
  }
  const keys = isEditing ? EDIT_KEYS : EXPLORE_KEYS;
  return (
    <div className="w-72 rounded-xl border border-gray-200/70 bg-white/95 p-3 shadow-xl backdrop-blur-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-gray-500">
          {isEditing ? "Editing keys" : "Exploring keys"}
        </span>
        <Button size="small" type="text" icon={<CloseOutlined />} onClick={onToggle} aria-label="Hide help" />
      </div>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
        {keys.map(([key, what]) => (
          <div key={key} className="contents">
            <dt>
              <kbd className="rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-mono text-xs text-gray-700">{key}</kbd>
            </dt>
            <dd className="m-0 text-gray-600">{what}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
