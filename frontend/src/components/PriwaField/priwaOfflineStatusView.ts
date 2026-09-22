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
    return { label: "Basiskarte offline nicht unterstützt", color: "warning" };
  }
  if (serviceWorkerStatus === "error") {
    return { label: "Basiskarte offline nicht bereit", color: "error" };
  }
  if (serviceWorkerStatus === "registering" || !isCacheAuditComplete) {
    return { label: "Basiskarte wird geprüft", color: "processing" };
  }
  if (coverageRatio >= PRIWA_OFFLINE_READY_COVERAGE_RATIO) {
    return { label: "Basiskarte offline bereit", color: "success" };
  }
  if (coverageRatio > 0) {
    return { label: "Basiskarte teilweise offline", color: "warning" };
  }
  if (needsRefresh) {
    return { label: "Basiskarte aktualisieren", color: "warning" };
  }
  if (hasAreas) {
    return {
      label: isOnline
        ? "Basiskarte hier nicht offline"
        : "Basiskarte hier nicht offline",
      color: "default",
    };
  }
  return {
    label: isOnline ? "Basiskarte offline laden" : "Keine Offline-Basiskarte",
    color: "default",
  };
};
