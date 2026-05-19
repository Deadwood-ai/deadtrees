export type PriwaServiceWorkerStatus =
  | "disabled"
  | "unsupported"
  | "registering"
  | "ready"
  | "error";

export interface IPriwaServiceWorkerSnapshot {
  status: PriwaServiceWorkerStatus;
  errorMessage: string | null;
}

const listeners = new Set<() => void>();

let snapshot: IPriwaServiceWorkerSnapshot = {
  status: import.meta.env.PROD ? "registering" : "disabled",
  errorMessage: null,
};

const notify = () => {
  listeners.forEach((listener) => listener());
};

const setSnapshot = (nextSnapshot: IPriwaServiceWorkerSnapshot) => {
  snapshot = nextSnapshot;
  notify();
};

export const getPriwaServiceWorkerSnapshot = () => snapshot;

export const subscribePriwaServiceWorker = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const registerPriwaServiceWorker = () => {
  if (!import.meta.env.PROD) {
    setSnapshot({ status: "disabled", errorMessage: null });
    return;
  }

  if (!("serviceWorker" in navigator)) {
    setSnapshot({ status: "unsupported", errorMessage: null });
    return;
  }

  setSnapshot({ status: "registering", errorMessage: null });

  navigator.serviceWorker
    .register("/sw.js")
    .then(() => navigator.serviceWorker.ready)
    .then(() => {
      setSnapshot({ status: "ready", errorMessage: null });
    })
    .catch((error: unknown) => {
      setSnapshot({
        status: "error",
        errorMessage:
          error instanceof Error
            ? error.message
            : "Service worker registration failed",
      });
    });
};
