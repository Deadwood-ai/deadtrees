import { useMemo, useState } from "react";
import { useBenchmarkAsset } from "./BenchmarkAccess";
import { filterBenchmarkSites } from "./benchmarkData";
import type { IBenchmarkSiteSummary } from "./types";

interface BenchmarkSitePickerProps {
  sites: IBenchmarkSiteSummary[];
  selected: string;
  onSelect: (id: string) => void;
}
export default function BenchmarkSitePicker({
  sites,
  selected,
  onSelect,
}: BenchmarkSitePickerProps) {
  const benchmarkAsset = useBenchmarkAsset();
  const [region, setRegion] = useState("global");
  const visible = useMemo(
    () => filterBenchmarkSites(sites, region),
    [sites, region],
  );
  return (
    <aside className="db-site-picker" aria-label="Reference site selection">
      <div className="db-picker-heading">
        <h2>Reference sites</h2>
        <span>N = {visible.length}</span>
      </div>
      <div className="db-region-tabs" aria-label="Filter sites by geography">
        {["global", "europe", "tropical"].map((value) => (
          <button
            key={value}
            aria-pressed={region === value}
            onClick={() => setRegion(value)}
          >
            {value[0].toUpperCase() + value.slice(1)}
          </button>
        ))}
      </div>
      <div className="db-site-list">
        {visible.map((site) => (
          <button
            key={site.id}
            className={`db-site-card ${selected === site.id ? "is-selected" : ""}`}
            aria-pressed={selected === site.id}
            onClick={() => onSelect(site.id)}
          >
            <img src={benchmarkAsset(site.thumbnail)} alt="" loading="lazy" />
            <span>
              <strong>{site.name}</strong>
              <small>
                {site.type} · {site.year}
              </small>
            </span>
            <span className="db-site-arrow" aria-hidden="true">
              →
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}
