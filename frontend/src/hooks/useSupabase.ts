import { createClient } from "@supabase/supabase-js";

import { Settings } from "../config";
import { isInvalidSessionError } from "../utils/authSession";

export const supabase = createClient(Settings.SUPABASE_URL, Settings.SUPABASE_ANON_KEY);

export function clearSupabaseAuthStorage() {
  const storageKey = supabase.auth.storageKey;

  if (typeof window !== "undefined" && storageKey) {
    window.localStorage.removeItem(storageKey);
    window.localStorage.removeItem(`${storageKey}-code-verifier`);
  }
}

export async function clearLocalSupabaseSession() {
  const { error } = await supabase.auth.signOut({ scope: "local" });

  if (error && !isInvalidSessionError(error)) {
    throw error;
  }

  clearSupabaseAuthStorage();
}
