import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "./useSupabase";

interface ProcessingEmailPreferenceRow {
  processing_emails_enabled: boolean;
  user_id: string;
}

export const processingEmailPreferenceQueryKey = (userId?: string) => [
  "notification-preferences",
  userId,
];

export function resolveProcessingEmailPreference(
  row: ProcessingEmailPreferenceRow | null | undefined,
): boolean {
  return row?.processing_emails_enabled ?? true;
}

export function useProcessingEmailPreference(userId?: string) {
  const queryClient = useQueryClient();
  const queryKey = processingEmailPreferenceQueryKey(userId);
  const query = useQuery({
    queryKey,
    enabled: !!userId,
    queryFn: async (): Promise<ProcessingEmailPreferenceRow | null> => {
      const { data, error } = await supabase
        .from("user_notification_preferences")
        .select("user_id,processing_emails_enabled")
        .eq("user_id", userId!)
        .maybeSingle();

      if (error) {
        throw error;
      }
      return data;
    },
  });

  const mutation = useMutation({
    mutationFn: async (enabled: boolean): Promise<ProcessingEmailPreferenceRow> => {
      if (!userId) {
        throw new Error("A signed-in user is required.");
      }

      const { data, error } = await supabase
        .from("user_notification_preferences")
        .upsert(
          {
            user_id: userId,
            processing_emails_enabled: enabled,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" },
        )
        .select("user_id,processing_emails_enabled")
        .single();

      if (error) {
        throw error;
      }
      return data;
    },
    onSuccess: (row) => {
      queryClient.setQueryData(queryKey, row);
    },
  });

  return {
    enabled: resolveProcessingEmailPreference(query.data),
    error: query.error ?? mutation.error,
    isLoading: query.isLoading,
    isSaving: mutation.isPending,
    setEnabled: mutation.mutate,
  };
}
