import type { PriwaServiceWorkerStatus } from "../../pwa/priwaServiceWorker";

export interface IPriwaOfflineStatusView {
  label: string;
  color: "default" | "error" | "processing" | "success" | "warning";
}

export const getPriwaOfflineStatusView = (
  serviceWorkerStatus: PriwaServiceWorkerStatus,
  isOnline: boolean,
): IPriwaOfflineStatusView => {
  if (!isOnline && serviceWorkerStatus === "ready") {
    return { label: "Offline bereit", color: "success" };
  }

  if (!isOnline) {
    return { label: "Offline eingeschränkt", color: "warning" };
  }

  if (serviceWorkerStatus === "ready") {
    return { label: "Offline bereit", color: "success" };
  }

  if (serviceWorkerStatus === "registering") {
    return { label: "Offline wird vorbereitet", color: "processing" };
  }

  if (serviceWorkerStatus === "error") {
    return { label: "Offline nicht bereit", color: "error" };
  }

  if (serviceWorkerStatus === "unsupported") {
    return { label: "Offline nicht unterstützt", color: "warning" };
  }

  return { label: "Offline nur im Build", color: "default" };
};
