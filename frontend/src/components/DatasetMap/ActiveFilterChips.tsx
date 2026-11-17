import { Button, Tag } from "antd";
import type { ActiveArchiveFilter } from "../../utils/datasetArchiveFilters";

interface Props {
  chips: ActiveArchiveFilter[];
  onRemove: (chip: ActiveArchiveFilter) => void;
  onClearAll: () => void;
}

/** The archive filters in effect, each removable on its own. */
export default function ActiveFilterChips({ chips, onRemove, onClearAll }: Props) {
  if (chips.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1" data-testid="dataset-active-filters">
      {chips.map((chip) => (
        <Tag
          key={chip.id}
          color="blue"
          closable
          onClose={(e) => {
            e.preventDefault();
            onRemove(chip);
          }}
          className="m-0 inline-flex max-w-[180px] items-center text-xs"
          title={chip.label}
        >
          <span className="truncate">{chip.label}</span>
        </Tag>
      ))}
      <Button
        type="link"
        size="small"
        className="h-auto p-0 text-xs"
        onClick={onClearAll}
        data-testid="dataset-active-filter-clear"
      >
        Clear all
      </Button>
    </div>
  );
}
