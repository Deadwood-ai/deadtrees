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
 * One search field for the archive. It searches authors and places by default;
 * the in-field mode menu switches it to open-vocabulary AI search.
 */
export default function ArchiveSearch({
  mode,
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
