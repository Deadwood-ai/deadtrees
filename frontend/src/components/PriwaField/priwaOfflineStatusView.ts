import type { PriwaServiceWorkerStatus } from "../../pwa/priwaServiceWorker";
import { PRIWA_OFFLINE_READY_COVERAGE_RATIO } from "./priwaOfflineCoverage";

export interface IPriwaOfflineStatusView {
  label: string;
  color: "default" | "error" | "processing" | "success" | "warning";
}

interface PriwaOfflineStatusInput {
  serviceWorkerStatus: PriwaServiceWorkerStatus;
  isOnline: boolean;
  isSupported: boolean;
  isCacheAuditComplete: boolean;
  hasAreas: boolean;
  needsRefresh: boolean;
  coverageRatio: number;
}

export const getPriwaOfflineStatusView = ({
  serviceWorkerStatus,
  isOnline,
  isSupported,
  isCacheAuditComplete,
  hasAreas,
  needsRefresh,
  coverageRatio,
}: PriwaOfflineStatusInput): IPriwaOfflineStatusView => {
  if (!isSupported || serviceWorkerStatus === "unsupported") {
    return { label: "Offline nicht unterstützt", color: "warning" };
  }
  if (serviceWorkerStatus === "error") {
    return { label: "Offline nicht bereit", color: "error" };
  }
  if (serviceWorkerStatus === "registering" || !isCacheAuditComplete) {
    return { label: "Offline wird geprüft", color: "processing" };
  }
  if (coverageRatio >= PRIWA_OFFLINE_READY_COVERAGE_RATIO) {
    return { label: "Offline bereit", color: "success" };
  }
  if (coverageRatio > 0) {
    return { label: "Teilweise offline", color: "warning" };
  }
  if (needsRefresh) {
    return { label: "Offline-Karte aktualisieren", color: "warning" };
  }
  if (hasAreas) {
    return {
      label: isOnline ? "Bereich nicht offline" : "Hier nicht offline",
      color: "default",
    };
  }
  return {
    label: isOnline ? "Offline-Karte laden" : "Keine Offline-Karte",
    color: "default",
  };
};
