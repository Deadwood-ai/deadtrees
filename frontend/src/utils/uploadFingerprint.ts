const SAMPLE_SIZE = 10 * 1024 * 1024;

export const sha256Hex = async (blob: Blob): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/**
 * The identity duplicate-upload detection compares: SHA-256 over the decimal
 * file size, the first `sampleSize` bytes and the last `sampleSize` bytes.
 * Must stay byte-for-byte equal to `get_file_identifier` in shared/hash.py.
 */
export const computeUploadFingerprint = async (file: Blob, sampleSize = SAMPLE_SIZE): Promise<string> => {
  const sampled = new Blob([
    String(file.size),
    file.slice(0, sampleSize),
    file.slice(Math.max(0, file.size - sampleSize)),
  ]);
  return sha256Hex(sampled);
};
