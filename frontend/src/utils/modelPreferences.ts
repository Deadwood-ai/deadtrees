import { ILabel, ILabelData, ILabelSource } from "../types/labels";

export type ModelConfig = Record<string, unknown>;
export type ModelPreferenceConfig = ModelConfig | null;

export const DEFAULT_MODEL_PREFERENCES: Record<
  ILabelData,
  ModelPreferenceConfig
> = {
  [ILabelData.DEADWOOD]: null,
  [ILabelData.FOREST_COVER]: null,
};

function configMatches(
  labelConfig: ModelConfig | null | undefined,
  preferredConfig: ModelPreferenceConfig,
): boolean {
  if (preferredConfig === null) return labelConfig == null;
  if (!labelConfig) return false;
  return Object.entries(preferredConfig).every(
    ([key, value]) => labelConfig[key] === value,
  );
}

export function selectPreferredModelLabel<
  T extends Pick<ILabel, "label_source" | "model_config" | "is_active">,
>(
  labels: T[],
  labelType: ILabelData,
  preferences?: ReadonlyMap<string, ModelPreferenceConfig>,
): T | null {
  const activeLabels = labels.filter((label) => label.is_active !== false);
  if (activeLabels.length === 0) return null;
  if (activeLabels.length === 1) return activeLabels[0];

  let preferredConfig = DEFAULT_MODEL_PREFERENCES[labelType];
  if (preferences?.has(labelType)) {
    const configuredPreference = preferences.get(labelType);
    preferredConfig =
      configuredPreference === undefined ? preferredConfig : configuredPreference;
  }

  const preferred = activeLabels.find(
    (label) =>
      label.label_source === ILabelSource.MODEL_PREDICTION &&
      configMatches(label.model_config, preferredConfig),
  );

  if (preferred) return preferred;

  return (
    activeLabels.find(
      (label) => label.label_source === ILabelSource.MODEL_PREDICTION,
    ) ?? activeLabels[0]
  );
}
