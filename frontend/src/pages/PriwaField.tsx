import PriwaFieldMap from "../components/PriwaField/PriwaFieldMap";
import { usePublicDatasetById } from "../hooks/useDatasets";

export default function PriwaField() {
  const { data: dataset6003, isLoading } = usePublicDatasetById(6003);

  return (
    <PriwaFieldMap
      cogPath={dataset6003?.cog_path ?? null}
      isCogLoading={isLoading}
    />
  );
}
