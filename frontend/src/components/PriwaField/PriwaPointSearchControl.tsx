import { SearchOutlined } from "@ant-design/icons";
import { Input, Select } from "antd";

import type { PriwaPointSearchField } from "./priwaPointTableData";

interface PriwaPointSearchControlProps {
  field: PriwaPointSearchField;
  search: string;
  onFieldChange: (field: PriwaPointSearchField) => void;
  onSearchChange: (search: string) => void;
}

export default function PriwaPointSearchControl({
  field,
  search,
  onFieldChange,
  onSearchChange,
}: PriwaPointSearchControlProps) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-slate-500">Suche</div>
      <div className="flex gap-1.5">
        <Select<PriwaPointSearchField>
          aria-label="Suchattribut auswählen"
          className="w-36 shrink-0"
          size="small"
          value={field}
          onChange={onFieldChange}
          options={[
            { label: "Alle Attribute", value: "all" },
            { label: "Baumnr", value: "baumnr" },
            { label: "Datum", value: "datum" },
            { label: "Befallsgruppe", value: "group" },
            { label: "Befliegungsdatei", value: "flight" },
            { label: "Baumart", value: "baumart" },
            { label: "Fund", value: "fund" },
            { label: "Name", value: "name" },
            { label: "Kommentar", value: "comment" },
            { label: "Positionsquelle", value: "source" },
          ]}
        />
        <Input
          aria-label="Käferbäume durchsuchen"
          allowClear
          className="min-w-0"
          size="small"
          prefix={<SearchOutlined className="text-slate-400" />}
          placeholder="Suchbegriff …"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </div>
    </div>
  );
}
