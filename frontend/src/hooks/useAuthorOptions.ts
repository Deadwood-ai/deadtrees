import { useState, useEffect } from "react";
import { useData } from "../hooks/useDataProvider";
import { useSupabase } from "../useSupabase";

interface AuthorOption {
  label: string;
  value: string;
}

export const useAuthorOptions = () => {
  const [options, setOptions] = useState<AuthorOption[]>([]);
  const { authors } = useData();

  useEffect(() => {
    if (authors) {
      const authorsUnique = [...new Set(authors)];

      const newOptions = authorsUnique.map((author) => ({
        label: author,
        value: author,
      }));

      setOptions(newOptions);
    }
  }, [authors]);

  return options;
};
