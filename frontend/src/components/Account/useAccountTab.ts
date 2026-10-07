import { useSearchParams } from "react-router-dom";

export const ACCOUNT_TABS = [
  { key: "datasets", label: "My Datasets" },
  { key: "shared", label: "Shared with me" },
  { key: "publications", label: "Published Datasets" },
  { key: "issues", label: "My Issues" },
] as const;

export type AccountTab = (typeof ACCOUNT_TABS)[number]["key"];

const isAccountTab = (value: string | null): value is AccountTab => ACCOUNT_TABS.some((tab) => tab.key === value);

/** The open account tab, kept in `?tab=` so links and the back button work. My Datasets is the default. */
export function useAccountTab() {
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab");
  const tab: AccountTab = isAccountTab(requested) ? requested : "datasets";

  const setTab = (next: AccountTab) =>
    setParams((current) => {
      const updated = new URLSearchParams(current);
      if (next === "datasets") updated.delete("tab");
      else {
        updated.set("tab", next);
        // The status drawer belongs to the dataset list.
        updated.delete("dataset");
      }
      return updated;
    });

  return [tab, setTab] as const;
}
