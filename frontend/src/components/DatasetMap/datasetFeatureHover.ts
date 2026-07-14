import type Feature from "ol/Feature";

type DatasetFeatureIndex = ReadonlyMap<number, readonly Feature[]>;

/**
 * Restyle only the dataset features whose hover state actually changed.
 * Returns the next ID so callers can keep their transition ref in sync.
 */
export function transitionDatasetFeatureHover(
  featuresById: DatasetFeatureIndex,
  previousId: number | null,
  nextId: number | null,
): number | null {
  if (previousId === nextId) return previousId;

  if (previousId !== null) {
    for (const feature of featuresById.get(previousId) ?? []) {
      feature.setStyle(feature.get("baseStyle"));
    }
  }

  if (nextId !== null) {
    for (const feature of featuresById.get(nextId) ?? []) {
      feature.setStyle(feature.get("hoverStyle"));
    }
  }

  return nextId;
}
