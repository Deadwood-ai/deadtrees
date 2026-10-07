import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "./useSupabase";

export interface IPublicationAuthorInput {
  first_name: string;
  last_name: string;
  organisation: string;
  orcid?: string;
  title?: string;
}

export interface ICreateDataPublicationInput {
  title: string;
  description?: string;
  authors: IPublicationAuthorInput[];
  datasetIds: number[];
}

const dataPublicationsKey = ["data-publications"];

// Datasets of the user that are in a publication request without a DOI yet.
// They cannot be selected for another publication.
export function useDatasetsInPublication(userId: string | undefined) {
  return useQuery({
    queryKey: [...dataPublicationsKey, "pending-datasets", userId],
    enabled: !!userId,
    queryFn: async (): Promise<number[]> => {
      const { data: publications, error } = await supabase
        .from("data_publication")
        .select("id")
        .eq("user_id", userId)
        .is("doi", null);
      if (error) throw error;
      if (!publications?.length) return [];

      const { data: links, error: linkError } = await supabase
        .from("jt_data_publication_datasets")
        .select("dataset_id")
        .in(
          "publication_id",
          publications.map((publication) => publication.id),
        );
      if (linkError) throw linkError;
      return (links ?? []).map((link) => link.dataset_id);
    },
  });
}

export interface IMyPublication {
  id: number;
  doi: string | null;
  title: string;
  description: string;
  created_at: string;
  datasets: number;
}

// The user's publication requests, newest first, each with its dataset count.
export function useMyPublications(userId: string | undefined) {
  return useQuery({
    queryKey: [...dataPublicationsKey, "mine", userId],
    enabled: !!userId,
    queryFn: async (): Promise<IMyPublication[]> => {
      const { data: publications, error } = await supabase
        .from("data_publication")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
      if (error) throw error;

      return Promise.all(
        (publications ?? []).map(async (publication) => {
          const { count, error: countError } = await supabase
            .from("jt_data_publication_datasets")
            .select("*", { count: "exact", head: true })
            .eq("publication_id", publication.id);
          if (countError) throw countError;
          return { ...publication, datasets: count ?? 0 };
        }),
      );
    },
  });
}

// Creates the publication, its authors and dataset links in one transaction.
export async function createDataPublication({
  title,
  description,
  authors,
  datasetIds,
}: ICreateDataPublicationInput): Promise<number> {
  const { data, error } = await supabase.rpc("create_data_publication", {
    p_title: title,
    p_description: description ?? null,
    p_authors: authors,
    p_dataset_ids: datasetIds,
  });
  if (error) throw error;
  return data as number;
}

export function useCreateDataPublication() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: createDataPublication,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: dataPublicationsKey }),
  });
}
