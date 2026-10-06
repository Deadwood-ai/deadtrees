import { describe, expect, it } from "vitest";

import { computeUploadFingerprint } from "./uploadFingerprint";

// Same vectors as shared/tests/test_hash.py: bytes i % 251, sample size 16.
const VECTORS: Array<[number, string]> = [
  [10, "d00c9d76fe9c85740e3d08371b58fc9c92bbdee56afd46ac4a1f1bdd77f3364d"],
  [24, "2d7b7e41a02547e61eb3856acbbaecba9bd3a7ec87dd5941b6c88dd30e2d5dda"],
  [100, "ef67568ee9adf13a1ea55a1d320a3b6766d2ff2d795e2366c8076befa58199ed"],
];

describe("computeUploadFingerprint", () => {
  it.each(VECTORS)("matches the backend fingerprint for a %i-byte file", async (size, expected) => {
    const file = new Blob([Uint8Array.from({ length: size }, (_, index) => index % 251)]);

    await expect(computeUploadFingerprint(file, 16)).resolves.toBe(expected);
  });
});
