import PriwaFieldMap from "../components/PriwaField/PriwaFieldMap";
import { usePriwaOfflineStatus } from "../components/PriwaField/usePriwaOfflineStatus";
import { usePriwaOfflineKaeferbaeume } from "../components/PriwaField/usePriwaOfflineKaeferbaeume";
import { usePriwaMosaics } from "../components/PriwaField/usePriwaMosaics";
import { usePriwaProjectMemberships } from "../hooks/usePriwaProjectMemberships";
import { Alert, Button, Result, Spin } from "antd";

export default function PriwaField() {
  const { isOnline, serviceWorker } = usePriwaOfflineStatus();
  const {
    data: memberships = [],
    error: membershipError,
    isLoading: isLoadingMemberships,
  } = usePriwaProjectMemberships();
  const activeMembership = memberships[0] ?? null;
  const {
    points,
    isLoading: isLoadingPoints,
    isRefetching,
    error: pointsError,
    createPoint,
    updatePoint,
    deletePoint,
    isSaving,
    syncSummary,
    syncNow,
  } = usePriwaOfflineKaeferbaeume(activeMembership?.projectId);
  const {
    data: mosaics = [],
    error: mosaicsError,
    isLoading: isLoadingMosaics,
    isRefetching: isRefetchingMosaics,
  } = usePriwaMosaics(activeMembership?.projectId);

  if (!isOnline && isLoadingMemberships) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-slate-50 p-6">
        <Result
          status="warning"
          title="PRIWA Felddaten offline noch nicht verfügbar"
          subTitle={
            serviceWorker.status === "ready"
              ? "Die App ist installiert und offline startbar. Bitte öffne PRIWA Field einmal online, damit Projekt und Punkte lokal verfügbar sind."
              : "Die App ist offline, bevor die Offline-Hülle vollständig vorbereitet wurde. Bitte öffne PRIWA Field einmal mit Internetverbindung."
          }
          extra={
            <Button type="primary" onClick={() => window.location.reload()}>
              Erneut versuchen
            </Button>
          }
        />
      </div>
    );
  }

  if (isLoadingMemberships) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-slate-950 text-white">
        <Spin size="large" />
      </div>
    );
  }

  if (membershipError) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-slate-50 p-6">
        <Alert
          type="error"
          showIcon
          message="PRIWA Mitgliedschaft konnte nicht geprüft werden"
          description={
            membershipError instanceof Error
              ? membershipError.message
              : "Bitte später erneut versuchen."
          }
        />
      </div>
    );
  }

  if (!activeMembership) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-slate-50 p-6">
        <Result
          status="403"
          title="Kein PRIWA Zugriff"
          subTitle="Diese Feldkarte ist nur für Mitglieder eines PRIWA Projekts verfügbar."
        />
      </div>
    );
  }

  return (
    <PriwaFieldMap
      points={points}
      projectId={activeMembership.projectId}
      projectName={activeMembership.projectName}
      isLoadingPoints={isLoadingPoints || isRefetching}
      isSavingPoint={isSaving}
      mosaics={mosaics}
      isCogLoading={isLoadingMosaics || isRefetchingMosaics}
      cogErrorMessage={
        mosaicsError instanceof Error ? mosaicsError.message : null
      }
      errorMessage={pointsError instanceof Error ? pointsError.message : null}
      onAddPoint={createPoint}
      onUpdatePoint={updatePoint}
      onDeletePoint={deletePoint}
      syncSummary={syncSummary}
      onSyncNow={syncNow}
    />
  );
}
