import { CloudUploadOutlined } from "@ant-design/icons";
import EmptyStatePanel from "../EmptyStatePanel";
import UploadButton from "../Upload/UploadButton";

interface MyDatasetsEmptyProps {
  /** Uploads are desktop-only, so the narrow layout leaves out the upload button. */
  isMobile?: boolean;
}

/** Empty state of the contributor's own dataset list, on desktop and mobile. */
export default function MyDatasetsEmpty({ isMobile = false }: MyDatasetsEmptyProps) {
  return (
    <EmptyStatePanel
      testId="my-datasets-empty"
      icon={<CloudUploadOutlined />}
      title="Map deadwood in your drone imagery"
      description="Upload an orthomosaic or raw drone images. DeadTrees maps deadwood and forest cover in them, and your datasets appear here."
      action={isMobile ? undefined : <UploadButton size="middle" label="Upload your first dataset" />}
    />
  );
}
