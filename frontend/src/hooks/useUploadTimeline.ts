import { useEffect, useMemo, useState } from "react";
import { IDataset } from "../types/dataset";

type ParsedDataset = {
  dataset: IDataset;
  createdAtMs: number;
  year: number;
  quarter: number;
};

type TimelinePeriod = {
  key: string;
  year: number;
  quarter: number;
  endMs: number;
  additions: number;
  cumulative: number;
};

const getQuarterFromMonth = (month: number): number => Math.floor(month / 3) + 1;

const getTimelineKey = (year: number, quarter: number): string => `${year}-Q${quarter}`;

const parseTimelineKey = (key: string): { year: number; quarter: number } | null => {
  const match = key.match(/^(\d{4})-Q([1-4])$/);
  if (!match) return null;
  return {
    year: Number(match[1]),
    quarter: Number(match[2]),
  };
};

const getQuarterEndMs = (year: number, quarter: number): number =>
  Date.UTC(year, quarter * 3, 0, 23, 59, 59, 999);

interface UploadTimelineResult {
  periods: string[];
  selectedPeriod: string;
  setSelectedPeriod: (period: string) => void;
  displayData: IDataset[] | null;
  cumulativeCount: number;
  addedInQuarter: number;
}

export function useUploadTimeline(processedData: IDataset[] | null): UploadTimelineResult {
  const [selectedPeriod, setSelectedPeriod] = useState<string>("");

  const parsedDatasets = useMemo<ParsedDataset[] | null>(() => {
    if (!processedData) return null;

    return processedData
      .map((dataset) => {
        const createdAtMs = Date.parse(dataset.created_at);
        if (Number.isNaN(createdAtMs)) return null;
        const createdAt = new Date(createdAtMs);
        return {
          dataset,
          createdAtMs,
          year: createdAt.getUTCFullYear(),
          quarter: getQuarterFromMonth(createdAt.getUTCMonth()),
        };
      })
      .filter((item): item is ParsedDataset => item !== null);
  }, [processedData]);

  const timelinePeriods = useMemo<TimelinePeriod[]>(() => {
    if (!parsedDatasets || parsedDatasets.length === 0) return [];

    let minYear = parsedDatasets[0].year;
    let maxYear = parsedDatasets[0].year;
    let latestYear = parsedDatasets[0].year;
    let latestQuarter = parsedDatasets[0].quarter;
    let latestMs = parsedDatasets[0].createdAtMs;

    const additionsByKey: Record<string, number> = {};
    parsedDatasets.forEach((item) => {
      if (item.year < minYear) minYear = item.year;
      if (item.year > maxYear) maxYear = item.year;
      if (item.createdAtMs > latestMs) {
        latestMs = item.createdAtMs;
        latestYear = item.year;
        latestQuarter = item.quarter;
      }
      const key = getTimelineKey(item.year, item.quarter);
      additionsByKey[key] = (additionsByKey[key] ?? 0) + 1;
    });

    const periods: TimelinePeriod[] = [];
    let runningTotal = 0;

    for (let year = minYear; year <= maxYear; year += 1) {
      for (let quarter = 1; quarter <= 4; quarter += 1) {
        const isBeforeOrAtLatest = year < latestYear || (year === latestYear && quarter <= latestQuarter);
        if (!isBeforeOrAtLatest) continue;

        const key = getTimelineKey(year, quarter);
        const additions = additionsByKey[key] ?? 0;
        runningTotal += additions;

        if (runningTotal > 0) {
          periods.push({
            key,
            year,
            quarter,
            endMs: getQuarterEndMs(year, quarter),
            additions,
            cumulative: runningTotal,
          });
        }
      }
    }

    return periods;
  }, [parsedDatasets]);

  const periodByKey = useMemo<Record<string, TimelinePeriod>>(
    () => Object.fromEntries(timelinePeriods.map((period) => [period.key, period])),
    [timelinePeriods],
  );

  const periods = useMemo(() => timelinePeriods.map((period) => period.key), [timelinePeriods]);
  const latestPeriodKey = timelinePeriods.length > 0 ? timelinePeriods[timelinePeriods.length - 1].key : "";

  useEffect(() => {
    if (!latestPeriodKey) {
      setSelectedPeriod("");
      return;
    }

    if (!selectedPeriod || !periodByKey[selectedPeriod]) {
      setSelectedPeriod(latestPeriodKey);
    }
  }, [latestPeriodKey, periodByKey, selectedPeriod]);

  const selectedMeta = selectedPeriod ? periodByKey[selectedPeriod] : undefined;

  const displayData = useMemo<IDataset[] | null>(() => {
    if (!processedData) return null;
    if (!parsedDatasets || !selectedMeta) return processedData;

    return parsedDatasets
      .filter((item) => item.createdAtMs <= selectedMeta.endMs)
      .map((item) => item.dataset);
  }, [processedData, parsedDatasets, selectedMeta]);

  return {
    periods,
    selectedPeriod,
    setSelectedPeriod,
    displayData,
    cumulativeCount: selectedMeta?.cumulative ?? 0,
    addedInQuarter: selectedMeta?.additions ?? 0,
  };
}

export { parseTimelineKey };
