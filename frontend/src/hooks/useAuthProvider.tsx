import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Session, User } from "@supabase/supabase-js";
import { identifyUser, trackAuthCompletion } from "../utils/analytics";

import { supabase } from "./useSupabase";

interface AuthProviderProps {
  children: React.ReactNode;
}

type AuthContextType = {
  session: Session | null;
  user: User | null;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType>({
  session: null,
  user: null,
  signOut: async () => {
    await supabase.auth.signOut();
  },
});

const AuthProvider = (props: AuthProviderProps) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);

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

  const signOut = useCallback(async () => {
    // Clear local auth state immediately so route guards and auth pages
    // cannot briefly see a stale signed-in session during sign-out.
    setSession(null);
    setUser(null);
    identifyUser(null);

    await supabase.auth.signOut();
  }, []);

  useEffect(() => {
    const { data: listener } = supabase.auth.onAuthStateChange(async (event, session) => {
      setSession(session);
      setUser(session?.user || null);

      // Identify user in PostHog when auth state changes
      if (!session?.user) {
        identifyUser(null);
        return;
      }

      const isCoreTeam = await getIsCoreTeam(session.user.id);
      identifyUser(session.user, { isCoreTeam });

      if (event === "SIGNED_IN") {
        const currentPath = window.location.pathname;
        if (currentPath.startsWith("/sign-up")) {
          trackAuthCompletion("sign_up_completed", { isCoreTeam, authPath: currentPath });
        } else if (currentPath.startsWith("/sign-in") || currentPath.startsWith("/reset-password")) {
          trackAuthCompletion("sign_in_completed", { isCoreTeam, authPath: currentPath });
        }
      }
    });

    const setData = async () => {
      const {
        data: { session },
        error,
      } = await supabase.auth.getSession();
      if (error) {
        throw error;
      }

      setSession(session);
      setUser(session?.user || null);

      // Identify user in PostHog when component mounts
      if (session?.user) {
        const isCoreTeam = await getIsCoreTeam(session.user.id);
        identifyUser(session.user, { isCoreTeam });
      } else {
        identifyUser(null);
      }
    };

    setData();

    return () => {
      listener.subscription.unsubscribe();
    };
  }, [getIsCoreTeam]);

  const value = {
    session,
    user,
    signOut,
  };

  return <AuthContext.Provider value={value}> {props.children} </AuthContext.Provider>;
};

export const useAuth = () => {
  return useContext(AuthContext);
};

export default AuthProvider;
