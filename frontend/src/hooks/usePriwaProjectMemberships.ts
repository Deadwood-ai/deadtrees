import { useQuery } from "@tanstack/react-query";

import { useAuth } from "./useAuthProvider";
import { supabase } from "./useSupabase";

export interface IPriwaProjectMembership {
  projectId: string;
  projectName: string;
  projectSlug: string;
  role: "field_user" | "coordinator" | "admin";
}

interface IPriwaMembershipRow {
  project_id: string;
  role: IPriwaProjectMembership["role"];
  priwa_projects:
    | {
        id: string;
        name: string;
        slug: string;
      }
    | Array<{
        id: string;
        name: string;
        slug: string;
      }>
    | null;
}

const firstProject = (project: IPriwaMembershipRow["priwa_projects"]) =>
  Array.isArray(project) ? (project[0] ?? null) : project;

export function usePriwaProjectMemberships() {
  const { status } = useAuth();

  return useQuery({
    queryKey: ["priwa-project-memberships"],
    enabled: status === "authenticated",
    queryFn: async () => {
      const { data, error } = await supabase
        .from("priwa_project_memberships")
        .select("project_id, role, priwa_projects(id, slug, name)")
        .order("created_at", { ascending: true });

      if (error) throw error;

      return ((data ?? []) as IPriwaMembershipRow[])
        .map((membership) => {
          const project = firstProject(membership.priwa_projects);
          if (!project) return null;

          return {
            projectId: membership.project_id,
            projectName: project.name,
            projectSlug: project.slug,
            role: membership.role,
          } satisfies IPriwaProjectMembership;
        })
        .filter((membership): membership is IPriwaProjectMembership => membership !== null);
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });
}
