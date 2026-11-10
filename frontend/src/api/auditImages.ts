import type { ISignedFilesGrant } from "../utils/signedFilesGrant";
import { fetchSignedFilesGrant } from "./signedFiles";

/** Signed links to the images the audit checks judged; auditors only. */
export const fetchAuditImages = (): Promise<ISignedFilesGrant> => fetchSignedFilesGrant("/audit/images/access");

/** The link of one stored image; storage_path is relative to the data directory and starts with audit/. */
export function auditImageUrl(grant: ISignedFilesGrant, storagePath: string): string {
  return `${grant.filesUrl}/${storagePath.replace(/^audit\//, "")}`;
}
