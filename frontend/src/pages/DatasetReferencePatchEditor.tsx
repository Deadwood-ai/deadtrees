import { useEffect, useRef, useState, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Button, message, Modal, Progress } from "antd";
import { ArrowLeftOutlined, CheckCircleOutlined } from "@ant-design/icons";
import { useDatasetById } from "../hooks/useDatasets";
import {
  usePatchSessionLock,
  useSetPatchSessionLock,
  useClearPatchSessionLock,
  usePatchProgress,
  useReferencePatches,
  useCompletePatchGeneration,
  useReopenPatchGeneration,
} from "../hooks/useReferencePatches";
import { useAuth } from "../hooks/useAuthProvider";
import ReferencePatchEditorView from "../components/ReferencePatches/ReferencePatchEditorView";
import { palette } from "../theme/palette";
import { MAP_FLOATING_TOP_CLASS } from "../theme/mapLayout";

export default function DatasetReferencePatchEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const datasetId = id ? parseInt(id, 10) : undefined;
  const { data: dataset } = useDatasetById(datasetId);

  const { data: sessionLock } = usePatchSessionLock(dataset?.id);
  const { mutateAsync: setLock } = useSetPatchSessionLock();
  const { mutateAsync: clearLock } = useClearPatchSessionLock();
  const { data: progress } = usePatchProgress(dataset?.id);
  const { data: allPatches = [] } = useReferencePatches(dataset?.id);
  const { mutateAsync: completePatchGeneration } = useCompletePatchGeneration();
  const { mutateAsync: reopenPatchGeneration } = useReopenPatchGeneration();

  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  // Count 20cm base patches
  const basePatchesCount = useMemo(() => allPatches.filter((p) => p.resolution_cm === 20).length, [allPatches]);

  // Calculate overall progress (only count 5cm patches - 10cm are auto-validated)
  const overallProgress = useMemo(() => {
    const total5 = progress?.total_5cm || 0;
    const good5 = progress?.good_5cm || 0;
    const bad5 = progress?.bad_5cm || 0;
    const completedPatches = good5 + bad5;
    return total5 > 0 ? Math.round((completedPatches / total5) * 100) : 0;
  }, [progress]);

  // Check if all 5cm patches are marked (no pending 5cm patches) and we have patches
  const allPatchesMarked = useMemo(() => {
    if (!progress) return false;
    const hasPatches = progress.total_5cm > 0;
    const noPending = progress.pending_5cm === 0;
    return hasPatches && noPending;
  }, [progress]);

  // Acquire lock once on mount; clear on unmount
  const lockAcquiredRef = useRef(false);
  const lockCheckedRef = useRef(false);

  // Check lock ownership once on mount
  useEffect(() => {
    if (!dataset?.id || !user?.id || !sessionLock || lockCheckedRef.current) return;

    lockCheckedRef.current = true;

    // If another user holds the lock, navigate away
    if (sessionLock.is_locked && sessionLock.locked_by && sessionLock.locked_by !== user.id) {
      message.error("Another user is currently editing patches for this dataset");
      navigate("/dataset-audit");
      return;
    }

    // Acquire lock if not already acquired
    if (!lockAcquiredRef.current) {
      setLock(dataset.id)
        .then(() => {
          lockAcquiredRef.current = true;
        })
        .catch((err) => {
          console.error("Failed to acquire lock:", err);
          message.error("Could not start patch generation session");
          navigate("/dataset-audit");
        });
    }
  }, [dataset?.id, user?.id, sessionLock, setLock, navigate]);

  // Clear lock on unmount
  useEffect(() => {
    return () => {
      if (lockAcquiredRef.current && dataset?.id) {
        clearLock(dataset.id);
        lockAcquiredRef.current = false;
      }
    };
  }, [dataset?.id, clearLock]);

  // Handle navigation away with unsaved changes
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = "";
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedChanges]);

  const handleBack = () => {
    if (hasUnsavedChanges) {
      Modal.confirm({
        title: "Unsaved Changes",
        content: "You have unsaved changes. Are you sure you want to leave?",
        okText: "Leave",
        cancelText: "Stay",
        onOk: () => {
          if (dataset?.id) {
            clearLock(dataset.id);
          }
          navigate(-1);
        },
      });
    } else {
      if (dataset?.id) {
        clearLock(dataset.id);
      }
      navigate(-1);
    }
  };

  const handleCompleteAndExit = () => {
    Modal.confirm({
      title: "Complete Reference Patch QA",
      content: (
        <div>
          <p>Mark this dataset as complete? This will:</p>
          <ul className="ml-4 mt-2 list-disc">
            <li>End your QA session</li>
            <li>Mark the dataset as having reference patches completed</li>
            <li>Release the session lock for other users</li>
          </ul>
          <p className="mt-2 font-semibold">
            Progress: {progress?.good_5cm || 0} good, {progress?.bad_5cm || 0} bad patches marked
          </p>
        </div>
      ),
      okText: "Complete & Exit",
      cancelText: "Cancel",
      okType: "primary",
      icon: <CheckCircleOutlined className="text-green-600" />,
      onOk: async () => {
        if (!dataset?.id) return;

        try {
          message.loading({ content: "Completing reference patch QA...", key: "complete" });

          // Mark as complete in database
          await completePatchGeneration(dataset.id);

          // Clear the lock
          await clearLock(dataset.id);
          lockAcquiredRef.current = false;

          message.success({
            content: "Reference patch QA completed successfully!",
            key: "complete",
            duration: 3,
          });

          // Navigate back to dataset list
          navigate("/dataset-audit");
        } catch (error) {
          console.error("Failed to complete patch generation:", error);
          message.error({
            content: "Failed to complete reference patch QA. Please try again.",
            key: "complete",
          });
        }
      },
    });
  };

  const handleReopenForEditing = async () => {
    if (!dataset?.id) return;

    try {
      message.loading({ content: "Reopening dataset for editing...", key: "reopen" });
      await reopenPatchGeneration(dataset.id);
      message.success({
        content: "Dataset reopened for editing!",
        key: "reopen",
        duration: 2,
      });
    } catch (error) {
      console.error("Failed to reopen dataset:", error);
      message.error({
        content: "Failed to reopen dataset. Please try again.",
        key: "reopen",
      });
    }
  };

  if (!dataset) {
    return <div className="p-6">Loading dataset...</div>;
  }

  return (
    <div className="relative flex h-screen w-full flex-col overflow-hidden bg-slate-50">
      <div
        className={`absolute left-4 right-4 ${MAP_FLOATING_TOP_CLASS} z-10 flex items-center justify-between rounded-2xl border border-gray-200/60 bg-white/95 p-4 shadow-xl backdrop-blur-sm pointer-events-auto`}
      >
        <div className="flex items-center gap-3">
          <Button icon={<ArrowLeftOutlined />} onClick={handleBack} />
          <div>
            <div className="text-lg font-semibold">Reference Patch Editor</div>
            <div className="text-sm text-gray-500">Dataset {dataset.id}</div>
          </div>
        </div>

        {/* Compact Progress Summary - only show 5cm patches (10cm auto-validated) */}
        {progress && (progress.total_5cm > 0 || basePatchesCount > 0) && (
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="text-xs text-gray-500">Patches</div>
              <div className="flex gap-2 text-xs">
                <span>
                  <span className="font-semibold">{basePatchesCount}</span> <span className="text-gray-500">base</span>
                </span>
                <span className="text-gray-300">|</span>
                <span>
                  <span className="font-semibold">{progress?.total_5cm || 0}</span>{" "}
                  <span className="text-gray-500">5cm QA</span>
                </span>
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs text-gray-500">QA Progress</div>
              <div className="text-sm font-semibold">{overallProgress}% Marked</div>
            </div>
            <Progress
              type="circle"
              percent={overallProgress}
              size={48}
              strokeColor={{ "0%": palette.primary[500], "100%": palette.forest[500] }}
            />

            {/* Complete & Exit Button - only show when all patches are marked */}
            {allPatchesMarked && (
              <Button type="primary" size="large" icon={<CheckCircleOutlined />} onClick={handleCompleteAndExit}>
                Complete & Exit
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="absolute inset-0 z-0 bg-slate-50">
        <ReferencePatchEditorView
          dataset={dataset}
          onUnsavedChanges={setHasUnsavedChanges}
          isCompleted={dataset.has_ml_tiles === true}
          onReopenForEditing={handleReopenForEditing}
        />
      </div>
    </div>
  );
}
