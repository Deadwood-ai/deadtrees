import { supabase } from "../hooks/useSupabase";
import { computeUploadFingerprint } from "../utils/uploadFingerprint";

/** A file that is already on the platform; `datasetId` is null when the caller may not see that dataset. */
export interface DuplicateUpload {
  datasetId: number | null;
}

/**
 * Asks before any bytes are sent whether this file would be rejected as a
 * duplicate. The API enforces the same rule when the upload completes, so a
 * failed lookup lets the upload proceed.
 */
export const findDuplicateUpload = async (file: Blob): Promise<DuplicateUpload | null> => {
  const { data, error } = await supabase.rpc("find_duplicate_upload", {
    p_fingerprint: await computeUploadFingerprint(file),
  });
  if (error || !data?.length) {
    return null;
  }
  return { datasetId: data[0].dataset_id };
};
