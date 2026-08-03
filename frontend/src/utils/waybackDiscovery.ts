import {
  getWaybackItems,
  getWaybackServiceBaseURL,
  lat2tile,
  long2tile,
  type WaybackItem,
} from "@esri/wayback-core";

export type WaybackPoint = {
  longitude: number;
  latitude: number;
};

type WaybackTilemapResponse = {
  data?: unknown[];
  select?: unknown[];
  size?: unknown[];
};

type DiscoverWaybackItemsOptions = {
  signal?: AbortSignal;
  onlyUseSizeToFilterDuplicates?: boolean;
  fetchImpl?: typeof globalThis.fetch;
  getItems?: typeof getWaybackItems;
  getServiceBaseUrl?: typeof getWaybackServiceBaseURL;
};

const throwIfAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;

  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw Object.assign(new Error("Wayback request aborted"), {
    name: "AbortError",
  });
};

/**
 * Abort-aware replacement for wayback-core's local-change discovery.
 *
 * wayback-core 1.1.0 accepts an AbortSignal but checks it only after its
 * recursive tilemap requests finish. This keeps the same tilemap/select walk
 * and size-only deduplication while passing the signal into every probe.
 */
export const discoverWaybackItemsWithLocalChanges = async (
  point: WaybackPoint,
  zoomLevel: number,
  {
    signal,
    onlyUseSizeToFilterDuplicates = true,
    fetchImpl = globalThis.fetch,
    getItems = getWaybackItems,
    getServiceBaseUrl = getWaybackServiceBaseURL,
  }: DiscoverWaybackItemsOptions = {},
): Promise<WaybackItem[]> => {
  const items = await getItems();
  throwIfAborted(signal);
  if (items.length === 0) return [];

  const level = Math.round(zoomLevel);
  const column = long2tile(point.longitude, level);
  const row = lat2tile(point.latitude, level);
  const itemByRelease = new Map(items.map((item) => [item.releaseNum, item]));
  const indexByRelease = new Map(
    items.map((item, index) => [item.releaseNum, index]),
  );
  const candidates: Array<{ releaseNum: number; size: number }> = [];
  const serviceBaseUrl = getServiceBaseUrl();
  let releaseNum: number | null = items[0].releaseNum;

  while (releaseNum !== null) {
    throwIfAborted(signal);
    const response = await fetchImpl(
      `${serviceBaseUrl}/tilemap/${releaseNum}/${level}/${row}/${column}`,
      { signal },
    );
    if (!response.ok) {
      throw new Error(
        `Wayback tilemap request failed for release ${releaseNum}: ${response.status}`,
      );
    }
    const tilemap = (await response.json()) as WaybackTilemapResponse;
    throwIfAborted(signal);

    if (!tilemap.data?.[0]) break;

    const selectedValue = tilemap.select?.[0];
    const selectedRelease = selectedValue ? Number(selectedValue) : NaN;
    const localChangeRelease = Number.isFinite(selectedRelease)
      ? selectedRelease
      : releaseNum;
    candidates.push({
      releaseNum: localChangeRelease,
      size: Number(tilemap.size?.[0]) || 0,
    });

    const localChangeIndex = indexByRelease.get(localChangeRelease);
    releaseNum =
      localChangeIndex === undefined
        ? null
        : (items[localChangeIndex + 1]?.releaseNum ?? null);
  }

  const selectedCandidates = onlyUseSizeToFilterDuplicates
    ? candidates.filter(
        (candidate, index) =>
          candidates[index + 1]?.size !== candidate.size,
      )
    : candidates;

  return selectedCandidates.flatMap((candidate) => {
    const item = itemByRelease.get(candidate.releaseNum);
    return item ? [item] : [];
  });
};
