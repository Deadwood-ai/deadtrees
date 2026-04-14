import { supabase } from "../useSupabase";

const getThumbnailURL = (file_name: string | null) => {
  if (!file_name) return "/assets/tree-icon.png";
  const url = supabase.storage
    .from("thumbnails")
    .getPublicUrl(file_name.replace("tif", "png"));
  return url.data.publicUrl;
};

export default getThumbnailURL;
