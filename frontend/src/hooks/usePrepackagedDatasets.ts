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

interface CreatePrepackagedDownloadGrantVariables {
  versionId: number;
  token: string;
}

export function useCreatePrepackagedDownloadGrant() {
  return useMutation({
    mutationFn: ({ versionId, token }: CreatePrepackagedDownloadGrantVariables) =>
      createPrepackagedDownloadGrant(versionId, token),
  });
}
