import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  fetchActivePriwaWarnkarte,
  fetchPriwaWarnkarteVersionOverlay,
  fetchPriwaWarnkarteVersions,
  importPriwaWarnkarte,
  publishPriwaWarnkarteVersion,
  validatePriwaWarnkarte,
  type IPriwaWarnkarteOverlay,
} from "../../api/priwaWarnkarte";
import { useAuth } from "../../hooks/useAuthProvider";

export function usePriwaWarnkarte(projectId: string, canManage: boolean) {
  const { session } = useAuth();
  const token = session?.access_token ?? null;
  const queryClient = useQueryClient();
  const [previewOverlay, setPreviewOverlay] =
    useState<IPriwaWarnkarteOverlay | null>(null);
  const [isVisible, setVisible] = useState(true);

  const activeQuery = useQuery({
    queryKey: ["priwa-warnkarte", projectId, "active"],
    enabled: !!projectId && !!token,
    queryFn: () => fetchActivePriwaWarnkarte(projectId, token!),
    staleTime: 60 * 1000,
  });
  const versionsQuery = useQuery({
    queryKey: ["priwa-warnkarte", projectId, "versions"],
    enabled: !!projectId && !!token && canManage,
    queryFn: () => fetchPriwaWarnkarteVersions(projectId, token!),
  });

  const requireToken = () => {
    if (!token) throw new Error("Die Anmeldung ist abgelaufen.");
    return token;
  };

  const validateFile = (file: File) =>
    validatePriwaWarnkarte(projectId, file, requireToken());

  const importFile = async (file: File, confirmedDate: string) => {
    const imported = await importPriwaWarnkarte(
      projectId,
      file,
      confirmedDate,
      requireToken(),
    );
    await queryClient.invalidateQueries({
      queryKey: ["priwa-warnkarte", projectId, "versions"],
    });
    const overlay = await fetchPriwaWarnkarteVersionOverlay(
      projectId,
      imported.version_id,
      requireToken(),
    );
    setPreviewOverlay(overlay);
    return imported;
  };

  const previewVersion = async (versionId: string) => {
    const overlay = await fetchPriwaWarnkarteVersionOverlay(
      projectId,
      versionId,
      requireToken(),
    );
    setPreviewOverlay(overlay);
  };

  const publishVersion = async (versionId: string) => {
    await publishPriwaWarnkarteVersion(versionId, requireToken());
    setPreviewOverlay(null);
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["priwa-warnkarte", projectId, "active"],
      }),
      queryClient.invalidateQueries({
        queryKey: ["priwa-warnkarte", projectId, "versions"],
      }),
    ]);
  };

  return {
    activeOverlay: activeQuery.data ?? null,
    displayedOverlay: previewOverlay ?? activeQuery.data ?? null,
    isPreviewing: previewOverlay !== null,
    isVisible,
    overlayError: activeQuery.error,
    previewOverlay,
    versions: versionsQuery.data ?? [],
    versionsError: versionsQuery.error,
    isLoadingVersions: versionsQuery.isLoading,
    clearPreview: () => setPreviewOverlay(null),
    toggleVisibility: () => setVisible((visible) => !visible),
    importFile,
    previewVersion,
    publishVersion,
    validateFile,
  };
}
