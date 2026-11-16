import { useMemo, type ReactNode } from "react";
import { Modal, Checkbox, Select, Slider, Button, DatePicker } from "antd";
import dayjs from "dayjs";
import { IBiome, IDataAccess, type IDatasetArchiveItem } from "../types/dataset";
import { useData } from "../hooks/useDataProvider";
import { getBiomeEmoji } from "../utils/biomeDisplay";
import { matchesSearchText } from "../utils/archiveTextSearch";
import {
  ACQUISITION_YEAR_FLOOR as FIRST_YEAR,
  EMPTY_ARCHIVE_FILTERS,
  GSD_STOPS_CM,
  MONTH_LABELS,
  accessLabel,
  type ArchiveFilters,
} from "../utils/datasetArchiveFilters";

interface FilterModalProps {
  isVisible: boolean;
  onClose: () => void;
  filters: ArchiveFilters;
  onChange: (filters: ArchiveFilters) => void;
  // The archive the filters apply to; it supplies the country list and counts.
  data: IDatasetArchiveItem[];
}

const PLATFORMS = ["drone", "airborne", "satellite"];
const ACCESS = [IDataAccess.public, IDataAccess.viewonly, IDataAccess.private];
const GSD_MAX_STOP = GSD_STOPS_CM.length - 1;

const filterOption = (input: string, option?: { label?: ReactNode }) =>
  matchesSearchText(String(option?.label ?? ""), input);

const countBy = (data: IDatasetArchiveItem[], key: (item: IDatasetArchiveItem) => string) => {
  const counts = new Map<string, number>();
  for (const item of data) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
};

// A range slider at its full extent is the same as no filter.
const rangeOrNull = (value: number[], min: number, max: number): [number, number] | null =>
  value[0] <= min && value[1] >= max ? null : [value[0], value[1]];

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-1 text-sm font-medium text-gray-700">{label}</div>
      {children}
    </div>
  );
}

const FilterModal: React.FC<FilterModalProps> = ({ isVisible, onClose, filters, onChange, data }) => {
  const { authors } = useData();
  const currentYear = new Date().getFullYear();
  const set = (patch: Partial<ArchiveFilters>) => onChange({ ...filters, ...patch });

  const countryOptions = useMemo(
    () =>
      [...countBy(data, (item) => item.admin_level_1 ?? "")]
        .filter(([country]) => country)
        .map(([country, count]) => ({ value: country, label: `${country} (${count})` }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [data],
  );
  const platformCounts = useMemo(() => countBy(data, (item) => item.platform), [data]);
  const accessCounts = useMemo(() => countBy(data, (item) => item.data_access), [data]);
  const biomeOptions = Object.values(IBiome).map((value) => ({
    label: `${getBiomeEmoji(value)} ${value}`,
    value,
  }));

  const gsdIndex = (cm: number) => Math.max(0, GSD_STOPS_CM.indexOf(cm));
  const gsdValue = filters.gsdCm
    ? [gsdIndex(filters.gsdCm[0]), gsdIndex(filters.gsdCm[1])]
    : [0, GSD_MAX_STOP];

  return (
    <Modal open={isVisible} onCancel={onClose} footer={null} title="Filters" width={600} centered>
      <Section label="Authors">
        <Select
          mode="multiple"
          placeholder="Any author"
          allowClear
          options={authors}
          value={filters.authors}
          onChange={(value: string[]) => set({ authors: value })}
          filterOption={filterOption}
          className="w-full"
        />
      </Section>

      <Section label="Country">
        <Select
          mode="multiple"
          placeholder="Any country"
          allowClear
          options={countryOptions}
          value={filters.countries}
          onChange={(value: string[]) => set({ countries: value })}
          filterOption={filterOption}
          className="w-full"
        />
      </Section>

      <Section label="Biome">
        <Select
          mode="multiple"
          placeholder="Any biome"
          allowClear
          options={biomeOptions}
          value={filters.biomes}
          onChange={(value: string[]) => set({ biomes: value })}
          filterOption={filterOption}
          className="w-full"
        />
      </Section>

      <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
        <Section label="Platform">
          <Checkbox.Group
            value={filters.platforms}
            onChange={(value) => set({ platforms: value as string[] })}
            options={PLATFORMS.map((platform) => ({
              value: platform,
              label: `${platform.charAt(0).toUpperCase()}${platform.slice(1)} (${platformCounts.get(platform) ?? 0})`,
            }))}
          />
        </Section>
        <Section label="Access">
          <Checkbox.Group
            value={filters.access}
            onChange={(value) => set({ access: value as IDataAccess[] })}
            options={ACCESS.filter(
              (access) => access !== IDataAccess.private || accessCounts.has(access),
            ).map((access) => ({
              value: access,
              label: `${accessLabel(access)} (${accessCounts.get(access) ?? 0})`,
            }))}
          />
        </Section>
      </div>

      <Section label="Acquisition year">
        <Slider
          range
          min={FIRST_YEAR}
          max={currentYear}
          value={filters.years ?? [FIRST_YEAR, currentYear]}
          onChange={(value) => set({ years: rangeOrNull(value, FIRST_YEAR, currentYear) })}
          marks={{ [FIRST_YEAR]: `≤${FIRST_YEAR}`, [currentYear]: String(currentYear) }}
        />
      </Section>

      <Section label="Acquisition month">
        <Slider
          range
          min={1}
          max={12}
          value={filters.months ?? [1, 12]}
          onChange={(value) => set({ months: rangeOrNull(value, 1, 12) })}
          tooltip={{ formatter: (month) => MONTH_LABELS[(month ?? 1) - 1] }}
          marks={Object.fromEntries(MONTH_LABELS.map((label, i) => [i + 1, label.charAt(0)]))}
        />
      </Section>

      <Section label="Resolution (cm per pixel)">
        <Slider
          range
          min={0}
          max={GSD_MAX_STOP}
          value={gsdValue}
          onChange={([from, to]) =>
            set({
              gsdCm:
                from === 0 && to === GSD_MAX_STOP ? null : [GSD_STOPS_CM[from], GSD_STOPS_CM[to]],
            })
          }
          tooltip={{ formatter: (i) => (i === GSD_MAX_STOP ? "any" : `${GSD_STOPS_CM[i ?? 0]} cm`) }}
          marks={Object.fromEntries(
            GSD_STOPS_CM.map((cm, i) => [i, i === GSD_MAX_STOP ? `${cm}+` : String(cm)]),
          )}
        />
      </Section>

      <Section label="Uploaded">
        <DatePicker.RangePicker
          className="w-full"
          allowEmpty={[true, true]}
          value={filters.uploaded ? [dayjs(filters.uploaded[0]), dayjs(filters.uploaded[1])] : null}
          onChange={(range) => {
            const [from, to] = range ?? [];
            set({
              uploaded:
                from || to
                  ? [(from ?? dayjs("2000-01-01")).format("YYYY-MM-DD"), (to ?? dayjs()).format("YYYY-MM-DD")]
                  : null,
            });
          }}
        />
      </Section>


      <div className="mt-6 flex justify-end gap-2">
        <Button onClick={() => onChange(EMPTY_ARCHIVE_FILTERS)}>Reset filters</Button>
        <Button type="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
};

export default FilterModal;
