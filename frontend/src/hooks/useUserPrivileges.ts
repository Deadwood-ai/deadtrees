import { useQuery } from "@tanstack/react-query";
import { supabase } from "./useSupabase";
import { useAuth } from "./useAuthProvider";

export interface UserPrivileges {
  id: number;
  user_id: string;
  /** Legacy flag; every signed-in user can upload private datasets. */
  can_upload_private: boolean;
  /** Platform override to manage any dataset's sharing. */
  can_manage_access?: boolean | null;
  can_audit: boolean;
  can_view_all_private: boolean;
  /** Factory workspace access. Read-only operational metadata, enforced server-side. */
  can_operate?: boolean | null;
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

// isError lets gated pages tell "the check failed" apart from "no access".
export function useCanAudit() {
  const { data: privileges, isLoading, isError, refetch } = useUserPrivileges();
  return {
    canAudit: privileges?.can_audit || false,
    isLoading,
    isError,
    refetch,
  };
}

export function useCanViewAllPrivate() {
  const { data: privileges, isLoading } = useUserPrivileges();
  return {
    canView: privileges?.can_view_all_private || false,
    isLoading,
  };
}

export function useCanOperate() {
  const { data: privileges, isLoading, isError, refetch } = useUserPrivileges();
  return {
    canOperate: privileges?.can_operate === true,
    isLoading,
    isError,
    refetch,
  };
}
