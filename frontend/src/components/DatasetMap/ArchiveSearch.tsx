import { Button, Dropdown, Input } from "antd";
import {
  CloseCircleOutlined,
  DownOutlined,
  EnterOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import type { ArchiveSearchMode } from "../../hooks/useArchiveSearch";

interface Props {
  mode: ArchiveSearchMode;
  canUseAiSearch: boolean;
  value: string;
  loading: boolean;
  onChange: (value: string) => void;
  onModeChange: (mode: ArchiveSearchMode) => void;
  onSubmit: () => void;
}

const MODE_LABEL: Record<ArchiveSearchMode, string> = {
  text: "Author / place",
  ai: "AI search",
};

/**
 * One search field for the archive. Public visitors search authors and places;
 * auditors can switch the same field to open-vocabulary AI search via the
 * in-field mode menu.
 */
export default function ArchiveSearch({
  mode,
  canUseAiSearch,
  value,
  loading,
  onChange,
  onModeChange,
  onSubmit,
}: Props) {
  const isAi = mode === "ai";
  return (
    <div className="dt-archive-search">
      <SearchOutlined aria-hidden className="dt-archive-search-icon" />
      <Input
        variant="borderless"
        aria-label={isAi ? "AI search" : "Search authors or places"}
        placeholder={isAi ? "Describe, e.g. standing dead trees" : "Author or place"}
        data-testid="dataset-search-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onPressEnter={onSubmit}
        allowClear={{
          clearIcon: <CloseCircleOutlined aria-label="Clear search" />,
        }}
      />
      {canUseAiSearch && (
        <Dropdown
          trigger={["click"]}
          menu={{
            selectedKeys: [mode],
            items: [
              { key: "text", label: MODE_LABEL.text },
              { key: "ai", label: MODE_LABEL.ai },
            ],
            onClick: ({ key }) => onModeChange(key as ArchiveSearchMode),
          }}
        >
          <Button
            type="text"
            size="small"
            aria-label="Search mode"
            className="dt-archive-search-mode"
          >
            {MODE_LABEL[mode]} <DownOutlined />
          </Button>
        </Dropdown>
      )}
      {isAi && (
        <Button
          type="text"
          size="small"
          aria-label="Run AI search"
          icon={<EnterOutlined />}
          loading={loading}
          disabled={!value.trim()}
          onClick={onSubmit}
        />
      )}
    </div>
  );
}
