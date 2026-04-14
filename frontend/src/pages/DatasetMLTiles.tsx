import { useEffect, useRef, useState, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Button, message, Modal, Progress } from "antd";
import { ArrowLeftOutlined, CheckCircleOutlined } from "@ant-design/icons";
import { useDatasetById } from "../hooks/useDatasets";
import {
  useTileSessionLock,
  useSetTileSessionLock,
  useClearTileSessionLock,
  useTileProgress,
  useMLTiles,
  useCompleteTileGeneration,
  useReopenTileGeneration,
} from "../hooks/useMLTiles";
import { useAuth } from "../hooks/useAuthProvider";
import MLTileUnifiedView from "../components/MLTiles/MLTileUnifiedView";
import { palette } from "../theme/palette";

export default function DatasetMLTiles() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const datasetId = id ? parseInt(id, 10) : undefined;
  const { data: dataset } = useDatasetById(datasetId);

  const { data: sessionLock } = useTileSessionLock(dataset?.id);
  const { mutateAsync: setLock } = useSetTileSessionLock();
  const { mutateAsync: clearLock } = useClearTileSessionLock();
  const { data: progress } = useTileProgress(dataset?.id);
  const { data: allTiles = [] } = useMLTiles(dataset?.id);
  const { mutateAsync: completeTileGeneration } = useCompleteTileGeneration();
  const { mutateAsync: reopenTileGeneration } = useReopenTileGeneration();

  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  // Count 20cm base tiles
  const baseTilesCount = useMemo(() => allTiles.filter((t) => t.resolution_cm === 20).length, [allTiles]);

  // Calculate overall progress (percent marked = good + bad)
  const overallProgress = useMemo(() => {
    const total10 = progress?.total_10cm || 0;
    const total5 = progress?.total_5cm || 0;
    const good10 = progress?.good_10cm || 0;
    const good5 = progress?.good_5cm || 0;
    const bad10 = progress?.bad_10cm || 0;
    const bad5 = progress?.bad_5cm || 0;
    const totalTiles = total10 + total5;
    const completedTiles = good10 + good5 + bad10 + bad5;
    return totalTiles > 0 ? Math.round((completedTiles / totalTiles) * 100) : 0;
  }, [progress]);

  // Check if all tiles are marked (no pending tiles) and we have tiles
  const allTilesMarked = useMemo(() => {
    if (!progress) return false;
    const hasTiles = progress.total_10cm > 0 || progress.total_5cm > 0;
    const noPending = progress.pending_10cm === 0 && progress.pending_5cm === 0;
    return hasTiles && noPending;
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
      message.error("Another user is currently editing tiles for this dataset");
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
          message.error("Could not start tile generation session");
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
      title: "Complete ML Tile QA",
      content: (
        <div>
          <p>Mark this dataset as complete? This will:</p>
          <ul className="ml-4 mt-2 list-disc">
            <li>End your QA session</li>
            <li>Mark the dataset as having ML tiles completed</li>
            <li>Release the session lock for other users</li>
          </ul>
          <p className="mt-2 font-semibold">
            Progress: {(progress?.good_10cm || 0) + (progress?.good_5cm || 0)} good,{" "}
            {(progress?.bad_10cm || 0) + (progress?.bad_5cm || 0)} bad tiles marked
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
          message.loading({ content: "Completing ML tile QA...", key: "complete" });

          // Mark as complete in database
          await completeTileGeneration(dataset.id);

          // Clear the lock
          await clearLock(dataset.id);
          lockAcquiredRef.current = false;

          message.success({
            content: "ML tile QA completed successfully!",
            key: "complete",
            duration: 3,
          });

          // Navigate back to dataset list
          navigate("/dataset-audit");
        } catch (error) {
          console.error("Failed to complete tile generation:", error);
          message.error({
            content: "Failed to complete ML tile QA. Please try again.",
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
      await reopenTileGeneration(dataset.id);
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
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center justify-between border-b p-4">
        <div className="flex items-center gap-3">
          <Button icon={<ArrowLeftOutlined />} onClick={handleBack} />
          <div>
            <div className="text-lg font-semibold">ML Training Tiles</div>
            <div className="text-sm text-gray-500">Dataset {dataset.id}</div>
          </div>
        </div>

        {/* Compact Progress Summary */}
        {progress && (progress.total_10cm > 0 || progress.total_5cm > 0 || baseTilesCount > 0) && (
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="text-xs text-gray-500">Tiles</div>
              <div className="flex gap-2 text-xs">
                <span>
                  <span className="font-semibold">{baseTilesCount}</span> <span className="text-gray-500">20cm</span>
                </span>
                <span className="text-gray-300">|</span>
                <span>
                  <span className="font-semibold">{progress?.total_10cm || 0}</span>{" "}
                  <span className="text-gray-500">10cm</span>
                </span>
                <span className="text-gray-300">|</span>
                <span>
                  <span className="font-semibold">{progress?.total_5cm || 0}</span>{" "}
                  <span className="text-gray-500">5cm</span>
                </span>
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs text-gray-500">Progress</div>
              <div className="text-sm font-semibold">{overallProgress}% Marked</div>
            </div>
            <Progress
              type="circle"
              percent={overallProgress}
              size={48}
              strokeColor={{ "0%": palette.primary[500], "100%": palette.forest[500] }}
            />

            {/* Complete & Exit Button - only show when all tiles are marked */}
            {allTilesMarked && (
              <Button type="primary" size="large" icon={<CheckCircleOutlined />} onClick={handleCompleteAndExit}>
                Complete & Exit
              </Button>
            )}
          </div>
        )}
      </div>

      <MLTileUnifiedView
        dataset={dataset}
        onUnsavedChanges={setHasUnsavedChanges}
        isCompleted={dataset.has_ml_tiles === true}
        onReopenForEditing={handleReopenForEditing}
      />
    </div>
  );
}
