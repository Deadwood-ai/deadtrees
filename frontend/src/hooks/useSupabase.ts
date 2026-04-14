import { createClient } from "@supabase/supabase-js";

import { Settings } from "../config";

export const supabase = createClient(Settings.SUPABASE_URL, Settings.SUPABASE_ANON_KEY);
