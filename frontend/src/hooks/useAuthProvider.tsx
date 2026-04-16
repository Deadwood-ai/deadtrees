import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Session, User } from "@supabase/supabase-js";

import { identifyUser, trackAuthCompletion } from "../utils/analytics";
import { getAuthErrorText, hasWellFormedJwt, isInvalidSessionError } from "../utils/authSession";

import { clearLocalSupabaseSession, clearSupabaseAuthStorage, supabase } from "./useSupabase";

interface AuthProviderProps {
  children: React.ReactNode;
}

export type AuthStatus = "checking" | "authenticated" | "anonymous";
export type AuthRecoveryReason = "session_expired" | null;

type AuthContextType = {
  loading: boolean;
  recoveryReason: AuthRecoveryReason;
  session: Session | null;
  status: AuthStatus;
  user: User | null;
  signOut: () => Promise<void>;
};

type AuthState = {
  recoveryReason: AuthRecoveryReason;
  session: Session | null;
  status: AuthStatus;
  user: User | null;
};

type SessionValidationResult =
  | {
      status: "valid";
      user: User;
    }
  | {
      status: "invalid";
    };

const anonymousState: AuthState = {
  recoveryReason: null,
  status: "anonymous",
  session: null,
  user: null,
};

const checkingState: AuthState = {
  recoveryReason: null,
  status: "checking",
  session: null,
  user: null,
};

const AuthContext = createContext<AuthContextType>({
  loading: true,
  recoveryReason: null,
  session: null,
  status: "checking",
  user: null,
  signOut: async () => {
    await supabase.auth.signOut();
  },
});

const AUTH_VALIDATION_TIMEOUT_MS = 2000;

const AuthProvider = ({ children }: AuthProviderProps) => {
  const authRequestRef = useRef(0);
  const authStateRef = useRef<AuthState>(checkingState);
  const [authState, setAuthState] = useState<AuthState>(checkingState);

  const getIsCoreTeam = useCallback(async (userId: string): Promise<boolean> => {
    const { data, error } = await supabase
      .from("privileged_users")
      .select("can_audit")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      console.error("Failed to load privileged user state for analytics", error);
      return false;
    }

    return data?.can_audit === true;
  }, []);

  const applyAnonymousState = useCallback((recoveryReason: AuthRecoveryReason = null) => {
    clearSupabaseAuthStorage();
    setAuthState({
      ...anonymousState,
      recoveryReason,
    });
    identifyUser(null);
  }, []);

  const applyAuthenticatedState = useCallback((session: Session, user: User) => {
    setAuthState({
      recoveryReason: null,
      status: "authenticated",
      session,
      user,
    });

    // Identify immediately so analytics stop treating the browser as anonymous.
    identifyUser(user);
  }, []);

  const enrichUserAnalytics = useCallback(
    async (user: User, requestId: number) => {
      const isCoreTeam = await getIsCoreTeam(user.id);

      if (authRequestRef.current !== requestId) {
        return;
      }

      identifyUser(user, { isCoreTeam });
    },
    [getIsCoreTeam],
  );

  const trackAuthCompletionForUser = useCallback(
    async (user: User, currentPath: string, requestId: number) => {
      const isCoreTeam = await getIsCoreTeam(user.id);

      if (authRequestRef.current !== requestId) {
        return;
      }

      if (currentPath.startsWith("/sign-up")) {
        trackAuthCompletion("sign_up_completed", { authPath: currentPath, isCoreTeam });
      } else if (currentPath.startsWith("/sign-in") || currentPath.startsWith("/reset-password")) {
        trackAuthCompletion("sign_in_completed", { authPath: currentPath, isCoreTeam });
      }
    },
    [getIsCoreTeam],
  );

  const recoverInvalidSession = useCallback(
    (error: unknown, requestId?: number) => {
      if (requestId !== undefined && authRequestRef.current !== requestId) {
        return;
      }

      console.warn("Clearing invalid local Supabase session", getAuthErrorText(error));
      applyAnonymousState("session_expired");

      void clearLocalSupabaseSession().catch((signOutError) => {
        console.error("Failed to clear local Supabase session", signOutError);
      });
    },
    [applyAnonymousState],
  );

  const validateSession = useCallback(
    async (nextSession: Session, requestId: number) => {
      if (!hasWellFormedJwt(nextSession.access_token)) {
        recoverInvalidSession(new Error("Stored access token is malformed."), requestId);
        return { status: "invalid" } satisfies SessionValidationResult;
      }

      const authValidationTimeout = Symbol("authValidationTimeout");
      const validationResult = await Promise.race([
        supabase.auth.getUser(),
        new Promise<typeof authValidationTimeout>((resolve) => {
          window.setTimeout(() => resolve(authValidationTimeout), AUTH_VALIDATION_TIMEOUT_MS);
        }),
      ]);

      if (authRequestRef.current !== requestId) {
        return null;
      }

      if (validationResult === authValidationTimeout) {
        throw new Error("Auth session validation timed out.");
      }

      const {
        data: { user: validatedUser },
        error,
      } = validationResult;

      if (error) {
        if (isInvalidSessionError(error)) {
          recoverInvalidSession(error, requestId);
          return { status: "invalid" } satisfies SessionValidationResult;
        }

        throw error;
      }

      if (!validatedUser) {
        recoverInvalidSession(new Error("Supabase returned no authenticated user for the restored session."), requestId);
        return { status: "invalid" } satisfies SessionValidationResult;
      }

      applyAuthenticatedState(nextSession, validatedUser);
      void enrichUserAnalytics(validatedUser, requestId);

      return {
        status: "valid",
        user: validatedUser,
      } satisfies SessionValidationResult;
    },
    [applyAuthenticatedState, enrichUserAnalytics, recoverInvalidSession],
  );

  const recoverTransientValidationFailure = useCallback(
    (nextSession: Session, error: unknown, requestId: number) => {
      if (authRequestRef.current !== requestId) {
        return;
      }

      console.warn("Auth session validation failed temporarily; keeping current session.", getAuthErrorText(error));
      applyAuthenticatedState(nextSession, nextSession.user);
      void enrichUserAnalytics(nextSession.user, requestId);
    },
    [applyAuthenticatedState, enrichUserAnalytics],
  );

  const restoreSession = useCallback(
    async (nextSession: Session, event?: string) => {
      const requestId = ++authRequestRef.current;
      const shouldShowCheckingState =
        event !== "TOKEN_REFRESHED" && authStateRef.current.status !== "authenticated";

      if (shouldShowCheckingState) {
        setAuthState(checkingState);
      }

      let validationResult: SessionValidationResult;
      try {
        validationResult = await validateSession(nextSession, requestId);
      } catch (error) {
        recoverTransientValidationFailure(nextSession, error, requestId);
        return null;
      }

      if (validationResult.status !== "valid") {
        return null;
      }

      if (event === "SIGNED_IN") {
        const currentPath = window.location.pathname;
        void trackAuthCompletionForUser(validationResult.user, currentPath, requestId);
      }

      return validationResult.user;
    },
    [recoverTransientValidationFailure, trackAuthCompletionForUser, validateSession],
  );

  const signOut = useCallback(async () => {
    authRequestRef.current += 1;
    applyAnonymousState();

    try {
      await supabase.auth.signOut();
    } catch (error) {
      if (!isInvalidSessionError(error)) {
        throw error;
      }
    } finally {
      clearSupabaseAuthStorage();
    }
  }, [applyAnonymousState]);

  useEffect(() => {
    authStateRef.current = authState;
  }, [authState]);

  useEffect(() => {
    let isMounted = true;

    const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === "INITIAL_SESSION" || !isMounted) {
        return;
      }

      if (!nextSession) {
        authRequestRef.current += 1;
        applyAnonymousState();
        return;
      }

      void restoreSession(nextSession, event);
    });

    const initializeAuth = async () => {
      const requestId = ++authRequestRef.current;
      setAuthState(checkingState);

      try {
        const {
          data: { session: restoredSession },
          error,
        } = await supabase.auth.getSession();

        if (authRequestRef.current !== requestId || !isMounted) {
          return;
        }

        if (error) {
          if (isInvalidSessionError(error)) {
            recoverInvalidSession(error, requestId);
            return;
          }

          throw error;
        }

        if (!restoredSession) {
          applyAnonymousState();
          return;
        }

        try {
          await validateSession(restoredSession, requestId);
        } catch (validationError) {
          recoverTransientValidationFailure(restoredSession, validationError, requestId);
        }
      } catch (error) {
        console.error("Failed to restore Supabase auth session", error);
        if (authRequestRef.current === requestId) {
          applyAnonymousState();
        }
      }
    };

    void initializeAuth();

    return () => {
      isMounted = false;
      listener.subscription.unsubscribe();
    };
  }, [applyAnonymousState, recoverInvalidSession, recoverTransientValidationFailure, restoreSession, validateSession]);

  const value = {
    loading: authState.status === "checking",
    recoveryReason: authState.recoveryReason,
    session: authState.session,
    status: authState.status,
    user: authState.user,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  return useContext(AuthContext);
};

export default AuthProvider;
