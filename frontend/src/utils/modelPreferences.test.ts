import { describe, expect, it } from "vitest";
import { ILabel, ILabelData, ILabelSource, ILabelType } from "../types/labels";
import { selectPreferredModelLabel } from "./modelPreferences";

function modelLabel(id: number, module: string | null): ILabel {
  return {
    id,
    dataset_id: 9739,
    user_id: "test-user",
    label_source: ILabelSource.MODEL_PREDICTION,
    label_type: ILabelType.SEMANTIC_SEGMENTATION,
    label_data: ILabelData.FOREST_COVER,
    model_config: module
      ? {
          module,
          checkpoint_name:
            module === "deadwood_treecover_combined_v2"
              ? "mitb3_seed200_ckpt_epoch_6_best_macro_f1.safetensors"
              : "legacy.safetensors",
        }
      : undefined,
    created_at: "2026-04-29T09:51:38.523681+00:00",
    updated_at: "2026-04-29T09:51:38.523681+00:00",
  };
}

describe("model preference label selection", () => {
  it("defaults to legacy model labels when preferences are unavailable", () => {
    const labels = [
      modelLabel(20762, null),
      modelLabel(20764, "deadwood_treecover_combined_v2"),
    ];

    expect(
      selectPreferredModelLabel(labels, ILabelData.FOREST_COVER, new Map())?.id,
    ).toBe(20762);
    expect(
      selectPreferredModelLabel(labels, ILabelData.FOREST_COVER, undefined)?.id,
    ).toBe(20762);
  });

  it("uses configured model preferences when they are available", () => {
    const labels = [
      modelLabel(20762, null),
      modelLabel(20764, "deadwood_treecover_combined_v2"),
    ];

    const preferences = new Map([
      [
        ILabelData.FOREST_COVER,
        {
          module: "deadwood_treecover_combined_v2",
          checkpoint_name:
            "mitb3_seed200_ckpt_epoch_6_best_macro_f1.safetensors",
        },
      ],
    ]);

    expect(
      selectPreferredModelLabel(labels, ILabelData.FOREST_COVER, preferences)
        ?.id,
    ).toBe(20764);
  });

  it("uses null preferences to select legacy model labels", () => {
    const labels = [
      modelLabel(20762, null),
      modelLabel(20764, "deadwood_treecover_combined_v2"),
    ];

    const preferences = new Map([[ILabelData.FOREST_COVER, null]]);

    expect(
      selectPreferredModelLabel(labels, ILabelData.FOREST_COVER, preferences)
        ?.id,
    ).toBe(20762);
  });

  it("ignores inactive model label versions", () => {
    const inactiveCombined = modelLabel(
      20764,
      "deadwood_treecover_combined_v2",
    );
    inactiveCombined.is_active = false;

    const activeLegacy = modelLabel(20762, "treecover_segmentation_oam_tcd");

    expect(
      selectPreferredModelLabel(
        [inactiveCombined, activeLegacy],
        ILabelData.FOREST_COVER,
        new Map(),
      )?.id,
    ).toBe(20762);
  });
});
