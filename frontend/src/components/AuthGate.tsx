import { Spin } from "antd";
import { ReactNode } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router-dom";

import { useAuth } from "../hooks/useAuthProvider";

function AuthLoadingScreen({ tip }: { tip: string }) {
  return (
    <div className="flex min-h-[calc(100vh-64px)] flex-col items-center justify-center gap-3 text-slate-600">
      <Spin size="large" />
      <span>{tip}</span>
    </div>
  );
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { recoveryReason, status } = useAuth();
  const location = useLocation();

  if (status === "checking") {
    return <AuthLoadingScreen tip="Checking session..." />;
  }

  if (status !== "authenticated") {
    const returnTo = `${location.pathname}${location.search}`;
    const params = new URLSearchParams();
    if (returnTo !== "/profile") {
      params.set("returnTo", returnTo);
    }
    if (recoveryReason === "session_expired") {
      params.set("reason", recoveryReason);
    }
    const signInUrl = params.size ? `/sign-in?${params.toString()}` : "/sign-in";
    return <Navigate replace to={signInUrl} />;
  }

  return <>{children}</>;
}

export function PublicOnly({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get("returnTo") || "/profile";

  if (status === "checking") {
    return <AuthLoadingScreen tip="Checking session..." />;
  }

  if (status === "authenticated") {
    return <Navigate replace to={returnTo} />;
  }

  return <>{children}</>;
}
