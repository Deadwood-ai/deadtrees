import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";

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
  const [selectedOverlay, setSelectedOverlay] =
    useState<IPriwaWarnkarteOverlay | null>(null);
  const selectedOverlayRequest = useRef(0);
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
    const request = ++selectedOverlayRequest.current;
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
    if (request === selectedOverlayRequest.current) {
      setSelectedOverlay(overlay);
    }
    return imported;
  };

  const showVersion = async (versionId: string) => {
    const request = ++selectedOverlayRequest.current;
    const overlay = await fetchPriwaWarnkarteVersionOverlay(
      projectId,
      versionId,
      requireToken(),
    );
    if (request === selectedOverlayRequest.current) {
      setSelectedOverlay(overlay);
    }
  };

  const publishVersion = async (versionId: string) => {
    const request = ++selectedOverlayRequest.current;
    await publishPriwaWarnkarteVersion(versionId, requireToken());
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["priwa-warnkarte", projectId, "active"],
      }),
      queryClient.invalidateQueries({
        queryKey: ["priwa-warnkarte", projectId, "versions"],
      }),
    ]);
    if (request === selectedOverlayRequest.current) {
      setSelectedOverlay(null);
    }
  };

  const clearSelectedVersion = useCallback(() => {
    selectedOverlayRequest.current += 1;
    setSelectedOverlay(null);
  }, []);

  return {
    activeOverlay: activeQuery.data ?? null,
    displayedOverlay: selectedOverlay ?? activeQuery.data ?? null,
    isVisible,
    overlayError: activeQuery.error,
    selectedOverlay,
    versions: versionsQuery.data ?? [],
    versionsError: versionsQuery.error,
    isLoadingVersions: versionsQuery.isLoading,
    clearSelectedVersion,
    toggleVisibility: () => setVisible((visible) => !visible),
    importFile,
    showVersion,
    publishVersion,
    validateFile,
  };
}
