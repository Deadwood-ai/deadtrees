import { ReactNode } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router-dom";

import { useAuth } from "../hooks/useAuthProvider";
import { StatusPageLoading } from "./StatusPage";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { recoveryReason, status } = useAuth();
  const location = useLocation();

  if (status === "checking") {
    return <StatusPageLoading label="Checking session…" />;
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
    const signInUrl = params.size
      ? `/sign-in?${params.toString()}`
      : "/sign-in";
    return <Navigate replace to={signInUrl} />;
  }

  return <>{children}</>;
}

export function PublicOnly({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get("returnTo") || "/profile";

  if (status === "checking") {
    return <StatusPageLoading label="Checking session…" />;
  }

  if (status === "authenticated") {
    return <Navigate replace to={returnTo} />;
  }

  return <>{children}</>;
}
