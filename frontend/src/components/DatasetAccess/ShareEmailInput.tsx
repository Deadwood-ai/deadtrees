import { useMemo } from "react";
import { AutoComplete } from "antd";
import { useShareAccountSearch } from "../../hooks/useDatasetAccess";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";

// Wait for a pause in typing before searching, so each keystroke is not a request.
const SEARCH_DELAY_MS = 250;

interface ShareEmailInputProps {
  datasetId: number;
  /** Lower-case emails that already have access, marked in the suggestions. */
  sharedEmails: Set<string>;
  id?: string;
  value?: string;
  onChange?: (value: string) => void;
}

/** Email field that suggests registered accounts once part of an address is typed. */
export default function ShareEmailInput({ datasetId, sharedEmails, id, value, onChange }: ShareEmailInputProps) {
  const query = useDebouncedValue(value ?? "", SEARCH_DELAY_MS);
  const { search, searching } = useShareAccountSearch(datasetId, query);
  // Earlier results stay as placeholder data, so hide them once the query is too short.
  const options = useMemo(
    () =>
      searching
        ? (search.data ?? []).map((email) => ({
            value: email,
            title: email,
            label: (
              <span className="flex justify-between gap-2">
                <span className="min-w-0 truncate">{email}</span>
                {sharedEmails.has(email.toLowerCase()) && <span className="shrink-0 text-gray-400">Has access</span>}
              </span>
            ),
          }))
        : [],
    [searching, search.data, sharedEmails],
  );

  return (
    <AutoComplete
      id={id}
      value={value}
      onChange={onChange}
      options={options}
      placeholder="colleague@example.org"
      notFoundContent={searching && !search.isFetching ? (search.isError ? search.error.message : "No account matches") : undefined}
    />
  );
}
