import { fetchSignedFilesGrant } from "./signedFiles";

/** Signed links to the internal disturbance benchmark files; core team only. */
export const fetchBenchmarkFiles = () => fetchSignedFilesGrant("/disturbance-benchmark/access");
