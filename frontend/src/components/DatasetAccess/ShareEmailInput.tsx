import { useEffect, useState } from "react";
import { AutoComplete } from "antd";
import { SHARE_ACCOUNT_SEARCH_MIN_LENGTH, useShareAccountSearch } from "../../hooks/useDatasetAccess";

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

function useDebouncedValue(value: string, delayMs: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Email field that suggests registered accounts once part of an address is typed. */
export default function ShareEmailInput({ datasetId, sharedEmails, id, value, onChange }: ShareEmailInputProps) {
  const query = useDebouncedValue((value ?? "").trim(), SEARCH_DELAY_MS);
  const searching = query.length >= SHARE_ACCOUNT_SEARCH_MIN_LENGTH;
  const search = useShareAccountSearch(datasetId, searching ? query : "");
  const options = searching
    ? (search.data ?? []).map((email) => ({
        value: email,
        label: (
          <span className="flex justify-between gap-2">
            <span className="break-all">{email}</span>
            {sharedEmails.has(email.toLowerCase()) && <span className="text-gray-400">Has access</span>}
          </span>
        ),
      }))
    : [];

  return (
    <AutoComplete
      id={id}
      value={value}
      onChange={onChange}
      options={options}
      placeholder="colleague@example.org"
      notFoundContent={searching && search.isError ? search.error.message : undefined}
    />
  );
}
