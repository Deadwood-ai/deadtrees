import PriwaFieldMap from "../components/PriwaField/PriwaFieldMap";
import { usePriwaOfflineStatus } from "../components/PriwaField/usePriwaOfflineStatus";
import { usePriwaOfflineKaeferbaeume } from "../components/PriwaField/usePriwaOfflineKaeferbaeume";
import { usePriwaMosaics } from "../components/PriwaField/usePriwaMosaics";
import { usePriwaBefallsgruppen } from "../components/PriwaField/usePriwaBefallsgruppen";
import { usePriwaProjectMemberships } from "../hooks/usePriwaProjectMemberships";
import { useIsMobile } from "../hooks/useIsMobile";
import { Alert, Button, Result, Spin } from "antd";
import PriwaWarnkarteAdminDrawer from "../components/PriwaField/PriwaWarnkarteAdminDrawer";
import PriwaWarnkarteStatus from "../components/PriwaField/PriwaWarnkarteStatus";
import { usePriwaWarnkarte } from "../components/PriwaField/usePriwaWarnkarte";

export default function PriwaField() {
  const { isOnline, serviceWorker } = usePriwaOfflineStatus();
  const {
    data: memberships = [],
    error: membershipError,
    isLoading: isLoadingMemberships,
  } = usePriwaProjectMemberships();
  const activeMembership = memberships[0] ?? null;
  const isMobile = useIsMobile();
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
    setFlightType,
    isClassifyingFlight,
  } = usePriwaMosaics(activeMembership?.projectId);
  const {
    groups,
    isLoading: isLoadingGroups,
    error: groupsError,
    saveGroup,
    addFlightToGroup,
    deleteGroup,
    isSaving: isSavingGroup,
  } = usePriwaBefallsgruppen(activeMembership?.projectId);
  const canManageWarnkarte = activeMembership?.role === "admin" && !isMobile;
  const warnkarte = usePriwaWarnkarte(
    activeMembership?.projectId ?? "",
    canManageWarnkarte,
  );

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
    <div className="relative min-h-[100dvh]">
      <PriwaFieldMap
        points={points}
        projectId={activeMembership.projectId}
        projectName={activeMembership.projectName}
        warnkarteOverlay={warnkarte.displayedOverlay}
        isLoadingPoints={isLoadingPoints || isRefetching}
        isSavingPoint={isSaving}
        mosaics={mosaics}
        groups={groups}
        isLoadingGroups={isLoadingGroups}
        isSavingGroup={isSavingGroup}
        groupsErrorMessage={
          groupsError instanceof Error ? groupsError.message : null
        }
        isCogLoading={isLoadingMosaics || isRefetchingMosaics}
        cogErrorMessage={
          mosaicsError instanceof Error ? mosaicsError.message : null
        }
        errorMessage={pointsError instanceof Error ? pointsError.message : null}
        onAddPoint={createPoint}
        onUpdatePoint={updatePoint}
        onDeletePoint={deletePoint}
        onSaveGroup={saveGroup}
        onAssignFlightToGroup={addFlightToGroup}
        onDeleteGroup={deleteGroup}
        onSetFlightType={setFlightType}
        isClassifyingFlight={isClassifyingFlight}
        syncSummary={syncSummary}
        onSyncNow={syncNow}
      />
      <PriwaWarnkarteStatus
        sourceDate={warnkarte.displayedOverlay?.source_date ?? null}
        isPreviewing={warnkarte.isPreviewing}
      />
      {canManageWarnkarte && (
        <PriwaWarnkarteAdminDrawer
          versions={warnkarte.versions}
          versionsError={warnkarte.versionsError}
          isLoadingVersions={warnkarte.isLoadingVersions}
          previewVersionId={warnkarte.previewOverlay?.version_id ?? null}
          onClearPreview={warnkarte.clearPreview}
          onValidate={warnkarte.validateFile}
          onImport={warnkarte.importFile}
          onPreview={warnkarte.previewVersion}
          onPublish={warnkarte.publishVersion}
        />
      )}
      {warnkarte.overlayError && (
        <Alert
          className="absolute bottom-4 left-1/2 z-[65] w-[min(32rem,calc(100%-2rem))] -translate-x-1/2 shadow-lg"
          type="error"
          showIcon
          message="Warnkarte konnte nicht geladen werden"
        />
      )}
    </div>
  );
}
