import { supabase } from "../hooks/useSupabase";
import { Settings } from "../config";

export const fetchData = async () => {
  const { data, error } = await supabase.from(Settings.DATA_TABLE_FULL).select("*").neq("data_access", "private");
  console.debug("fetched data", data);
  if (error) throw error;
  return data;
};
