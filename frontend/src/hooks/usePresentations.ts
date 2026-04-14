import { useQuery } from "@tanstack/react-query";
import { supabase } from "./useSupabase";

interface Presentation {
  id: number;
  title: string;
  speaker: string;
  date: string;
  event: string;
  url: string;
}

export const usePresentations = () => {
  return useQuery({
    queryKey: ["presentations"],
    queryFn: async () => {
      const { data, error } = await supabase.from("presentations").select("*").order("date", { ascending: true });

      if (error) throw error;
      return data as Presentation[];
    },
  });
};
