import PriwaFieldMap from "../components/PriwaField/PriwaFieldMap";
import { usePriwaKaeferbaeume } from "../components/PriwaField/usePriwaKaeferbaeume";
import { usePriwaProjectMemberships } from "../hooks/usePriwaProjectMemberships";
import { Alert, Result, Spin } from "antd";

export default function PriwaField() {
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
  } = usePriwaKaeferbaeume(activeMembership?.projectId);

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
      projectName={activeMembership.projectName}
      isLoadingPoints={isLoadingPoints || isRefetching}
      isSavingPoint={isSaving}
      cogPath={null}
      errorMessage={
        pointsError instanceof Error ? pointsError.message : null
      }
      onAddPoint={createPoint}
      onUpdatePoint={updatePoint}
      onDeletePoint={deletePoint}
    />
  );
}
