import { useQuery } from "@tanstack/react-query";
import { supabase } from "./useSupabase";
import { useAuth } from "./useAuthProvider";

export interface UserPrivileges {
  id: number;
  user_id: string;
  can_upload_private: boolean;
  can_audit: boolean;
  can_view_all_private: boolean;
  created_at: string;
}

export function useUserPrivileges() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["userPrivileges", user?.id],
    queryFn: async () => {
      if (!user?.id) return null;

      const { data, error } = await supabase.from("privileged_users").select("*").eq("user_id", user.id).maybeSingle();

      if (error) throw error;
      return data as UserPrivileges | null;
    },
    enabled: !!user?.id,
  });
}

export function useCanAudit() {
  const { data: privileges, isLoading } = useUserPrivileges();
  return {
    canAudit: privileges?.can_audit || false,
    isLoading,
  };
}

export function useCanUploadPrivate() {
  const { data: privileges, isLoading } = useUserPrivileges();
  return {
    canUpload: privileges?.can_upload_private || false,
    isLoading,
  };
}

export function useCanViewAllPrivate() {
  const { data: privileges, isLoading } = useUserPrivileges();
  return {
    canView: privileges?.can_view_all_private || false,
    isLoading,
  };
}
