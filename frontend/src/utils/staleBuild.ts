// After a deploy, the previous build's lazy chunks are gone, so an open tab
// fails when it opens a route it has not loaded yet. Reloading fetches the new
// build; the guard keeps a genuinely broken network from reloading in a loop.
const STALE_BUILD_PATTERN =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|Loading (CSS )?chunk .+ failed|ChunkLoadError/i;

const RELOAD_KEY = "dt-stale-build-reload-at";
const RELOAD_COOLDOWN_MS = 30_000;

export function isStaleBuildError(error: unknown): boolean {
  if (!error) return false;
  const text =
    error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return STALE_BUILD_PATTERN.test(text);
}

// Returns true when a reload was started; false when one already ran recently
// (the caller then shows the error page instead of reloading again).
export function reloadForNewBuild(
  storage:
    Pick<Storage, "getItem" | "setItem"> | undefined = safeSessionStorage(),
  reload: () => void = () => window.location.reload(),
  now: number = Date.now(),
): boolean {
  // Without storage there is no loop guard, so leave it to the error page.
  if (!storage) return false;
  const last = Number(storage.getItem(RELOAD_KEY) ?? 0);
  if (now - last < RELOAD_COOLDOWN_MS) return false;
  try {
    storage.setItem(RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  reload();
  return true;
}

function safeSessionStorage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}
