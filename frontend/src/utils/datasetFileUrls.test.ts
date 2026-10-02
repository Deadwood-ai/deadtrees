import { describe, expect, it } from "vitest";
import { Settings } from "../config";
import { resolveDatasetFileUrls } from "./datasetFileUrls";

describe("resolveDatasetFileUrls", () => {
  it("serves public and view-only files from the static file server", () => {
    for (const data_access of ["public", "viewonly"]) {
      expect(
        resolveDatasetFileUrls({ id: 1, data_access, cog_path: "abc/1_cog.tif", thumbnail_path: "def/1.jpg" }),
      ).toEqual({ cogUrl: `${Settings.COG_BASE_URL}abc/1_cog.tif`, thumbnailUrl: `${Settings.THUMBNAIL_URL}def/1.jpg` });
    }
  });

  it("never builds a static address for a private dataset", () => {
    const dataset = { id: 2, data_access: "private", cog_path: "abc/2_cog.tif", thumbnail_path: "def/2.jpg" };
    expect(resolveDatasetFileUrls(dataset)).toEqual({ cogUrl: null, thumbnailUrl: null });
    expect(
      resolveDatasetFileUrls(dataset, {
        cog_url: "https://api.example/datasets/2/files/cog/t",
        thumbnail_url: null,
        expires_at: 1,
      }),
    ).toEqual({ cogUrl: "https://api.example/datasets/2/files/cog/t", thumbnailUrl: null });
  });
});
