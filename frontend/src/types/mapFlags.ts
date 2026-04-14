export type MapFlagCategory = "incorrect_prediction" | "missing_deadwood" | "other";

export interface IMapFlag {
  id: number;
  created_by: string;
  bbox: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat] in EPSG:4326
  description: string;
  category: MapFlagCategory;
  year?: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateMapFlagInput {
  bbox: [number, number, number, number];
  description: string;
  category?: MapFlagCategory;
  year?: string;
}

