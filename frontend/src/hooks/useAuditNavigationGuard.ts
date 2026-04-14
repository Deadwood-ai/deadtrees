import React, { useEffect, useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Modal } from "antd";

interface UseAuditNavigationGuardOptions {
  isActive: boolean;
  onCleanup: () => Promise<void>;
  datasetId: number;
  hasFormChanges: boolean;
}

export function useAuditNavigationGuard({
  isActive,
  onCleanup,
  datasetId,
  hasFormChanges,
}: UseAuditNavigationGuardOptions) {
  const navigate = useNavigate();
  const [isCleaningUp, setIsCleaningUp] = useState(false);
  const cleanupTimeoutRef = useRef<NodeJS.Timeout>();
  const originalNavigateRef = useRef(navigate);

  // Cleanup function with timeout
  const performCleanup = useCallback(async () => {
    if (isCleaningUp) return;

    try {
      setIsCleaningUp(true);
      await onCleanup();
    } catch (error) {
      console.error("Cleanup failed:", error);
    } finally {
      setIsCleaningUp(false);
    }
  }, [onCleanup, isCleaningUp]);

  // Show confirmation modal with auto-cleanup timeout (or proceed directly if no changes)
  const showExitConfirmation = useCallback(
    (proceedCallback: () => void) => {
      // If no form changes, just cleanup and proceed without showing dialog
      if (!hasFormChanges) {
        performCleanup().then(() => {
          proceedCallback();
        });
        return;
      }

      // Clear any existing timeout
      if (cleanupTimeoutRef.current) {
        clearTimeout(cleanupTimeoutRef.current);
      }

      const modal = Modal.confirm({
        title: "🚨 Leave Audit Process?",
        content:
          "Your current audit progress will be lost if you proceed. The dataset will be unlocked for other users. This dialog will auto-proceed in 60 seconds if no action is taken.",
        okText: "Leave Audit",
        cancelText: "Stay in Audit",
        okType: "danger",
        width: 500,
        onOk: async () => {
          if (cleanupTimeoutRef.current) {
            clearTimeout(cleanupTimeoutRef.current);
          }
          await performCleanup();
          proceedCallback();
        },
        onCancel: () => {
          if (cleanupTimeoutRef.current) {
            clearTimeout(cleanupTimeoutRef.current);
          }
        },
      });

      // Auto-cleanup after 1 minute
      cleanupTimeoutRef.current = setTimeout(async () => {
        modal.destroy();
        await performCleanup();
        proceedCallback();
      }, 60000); // 60 seconds
    },
    [performCleanup, hasFormChanges],
  );

  // Block browser refresh/close
  useEffect(() => {
    if (!isActive) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "Your audit progress will be lost. The dataset will be unlocked.";

      // Attempt cleanup (may or may not complete before page unloads)
      performCleanup();

      return "Your audit progress will be lost. The dataset will be unlocked.";
    };

    const handleUnload = () => {
      // Last chance cleanup attempt
      navigator.sendBeacon("/api/audit-cleanup", JSON.stringify({ datasetId }));
    };

    const handleVisibilityChange = () => {
      // If page becomes hidden and we're in audit, start a cleanup timer
      if (document.hidden && isActive) {
        console.debug("Page hidden during audit - starting cleanup timer");
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("unload", handleUnload);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("unload", handleUnload);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isActive, performCleanup, datasetId]);

  // Intercept programmatic navigation
  useEffect(() => {
    if (!isActive) return;

    const interceptedNavigate = (...args: Parameters<typeof navigate>) => {
      showExitConfirmation(() => {
        originalNavigateRef.current(...args);
      });
    };

    // Store original and replace
    originalNavigateRef.current = navigate;
    Object.assign(navigate, interceptedNavigate);

    return () => {
      // Restore original navigate
      Object.assign(navigate, originalNavigateRef.current);
    };
  }, [isActive, showExitConfirmation, navigate]);

  // Listen for navigation attempts from other components
  useEffect(() => {
    if (!isActive) return;

    const handleNavigationAttempt = (event: CustomEvent) => {
      const { to, replace = false } = event.detail;

      showExitConfirmation(() => {
        if (replace) {
          originalNavigateRef.current(to, { replace: true });
        } else {
          originalNavigateRef.current(to);
        }
      });
    };

    window.addEventListener("audit-navigation-attempt", handleNavigationAttempt as EventListener);

    return () => {
      window.removeEventListener("audit-navigation-attempt", handleNavigationAttempt as EventListener);
    };
  }, [isActive, showExitConfirmation]);

  // Handle browser back/forward
  useEffect(() => {
    if (!isActive) return;

    const handlePopState = (event: PopStateEvent) => {
      event.preventDefault();
      window.history.pushState(null, "", window.location.href); // Prevent actual navigation

      showExitConfirmation(() => {
        window.history.back();
      });
    };

    // Push a state to detect back navigation
    window.history.pushState(null, "", window.location.href);
    window.addEventListener("popstate", handlePopState);

    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [isActive, showExitConfirmation]);

  return {
    showExitConfirmation,
    isCleaningUp,
    performCleanup,
  };
}
