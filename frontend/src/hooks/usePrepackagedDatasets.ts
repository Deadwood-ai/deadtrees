import { useMutation, useQuery } from "@tanstack/react-query";

import {
  createPrepackagedDownloadGrant,
  fetchPrepackagedPackages,
} from "../api/prepackaged";

export function usePrepackagedDatasets() {
  return useQuery({
    queryKey: ["prepackaged-datasets"],
    queryFn: () => fetchPrepackagedPackages(),
  });
}

export function useCreatePrepackagedDownloadGrant(token?: string) {
  return useMutation({
    mutationFn: (versionId: number) =>
      createPrepackagedDownloadGrant(versionId, token as string),
  });
}
