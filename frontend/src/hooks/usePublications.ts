import { useQuery } from "@tanstack/react-query";
import { supabase } from "./useSupabase";

interface Publication {
  id: number;
  title: string;
  authors: string;
  year: string;
  url: string;
  publication_date: string | null;
  publisher: string;
  data_url?: string | null;
}

const getPublicationTimestamp = (publicationDate: string | null) => {
  if (!publicationDate) return Number.NEGATIVE_INFINITY;

  const timestamp = Date.parse(publicationDate);
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
};

export const usePublications = () => {
  return useQuery({
    queryKey: ["publications"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("publications")
        .select("*")
        .order("publication_date", { ascending: false, nullsFirst: false });

      if (error) throw error;

      return [...((data ?? []) as Publication[])].sort((a, b) => {
        const publicationDateDifference =
          getPublicationTimestamp(b.publication_date) - getPublicationTimestamp(a.publication_date);

        if (publicationDateDifference !== 0) return publicationDateDifference;

        return b.id - a.id;
      });
    },
  });
};
