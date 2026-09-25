import { useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Modal } from "antd";

interface UseAuditNavigationGuardOptions {
  isActive: boolean;
  hasFormChanges: boolean;
}

/**
 * Confirms leaving an audit with unsaved changes. The audit lease is released by
 * useAuditLock when the page unmounts or exits, so leaving needs no cleanup here.
 */
export function useAuditNavigationGuard({ isActive, hasFormChanges }: UseAuditNavigationGuardOptions) {
  const navigate = useNavigate();

  const showExitConfirmation = useCallback(
    (proceedCallback: () => void) => {
      if (!hasFormChanges) {
        proceedCallback();
        return;
      }

      Modal.confirm({
        title: "🚨 Leave Audit Process?",
        content:
          "Your current audit progress will be lost if you proceed. The dataset will be unlocked for other users.",
        okText: "Leave Audit",
        cancelText: "Stay in Audit",
        okType: "danger",
        width: 500,
        onOk: proceedCallback,
      });
    },
    [hasFormChanges],
  );

  // Ask before browser refresh/close
  useEffect(() => {
    if (!isActive) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "Your audit progress will be lost. The dataset will be unlocked.";
      return "Your audit progress will be lost. The dataset will be unlocked.";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isActive]);

  // Listen for navigation attempts from other components
  useEffect(() => {
    if (!isActive) return;

    const handleNavigationAttempt = (event: CustomEvent) => {
      const { to, replace = false } = event.detail;

      showExitConfirmation(() => {
        navigate(to, { replace });
      });
    };

    window.addEventListener("audit-navigation-attempt", handleNavigationAttempt as EventListener);

    return () => {
      window.removeEventListener("audit-navigation-attempt", handleNavigationAttempt as EventListener);
    };
  }, [isActive, showExitConfirmation, navigate]);

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

  return { showExitConfirmation };
}
