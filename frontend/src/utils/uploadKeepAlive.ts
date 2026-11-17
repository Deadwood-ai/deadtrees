// While any upload runs: warn before the tab closes, and keep the screen (and so
// the laptop) awake while the tab is visible. Browsers release a wake lock when
// the tab is hidden, so it is taken again when the tab comes back.
type WakeLockSentinelLike = { release: () => Promise<void> };
type WakeLockNavigator = Navigator & { wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> } };

let activeUploads = 0;
let wakeLock: WakeLockSentinelLike | null = null;

const warnBeforeClose = (event: BeforeUnloadEvent) => {
  event.preventDefault();
  // Older browsers need a return value to show the dialog.
  event.returnValue = "";
};

const requestWakeLock = async () => {
  const nav = navigator as WakeLockNavigator;
  if (!nav.wakeLock || document.visibilityState !== "visible" || wakeLock) return;
  try {
    wakeLock = await nav.wakeLock.request("screen");
  } catch {
    // Denied (battery saver, unsupported): the upload still runs, it may just pause on sleep.
  }
};

const onVisibilityChange = () => {
  if (document.visibilityState === "visible") {
    wakeLock = null;
    void requestWakeLock();
  }
};

/** Call when an upload starts; call the returned function once when it ends. */
export const holdUploadKeepAlive = (): (() => void) => {
  if (typeof window === "undefined") return () => undefined;
  activeUploads++;
  if (activeUploads === 1) {
    window.addEventListener("beforeunload", warnBeforeClose);
    document.addEventListener("visibilitychange", onVisibilityChange);
    void requestWakeLock();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeUploads--;
    if (activeUploads === 0) {
      window.removeEventListener("beforeunload", warnBeforeClose);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      void wakeLock?.release().catch(() => undefined);
      wakeLock = null;
    }
  };
};
