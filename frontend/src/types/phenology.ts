export interface PhenologyMetadata {
  phenology_curve: number[]; // 366 values, 0-255 range
  source: string;
  version: string;
}

export interface DatasetMetadata {
  gadm?: AdminBoundariesMetadata;
  biome?: BiomeMetadata;
  phenology?: PhenologyMetadata;
}

// Additional interfaces for completeness
export interface AdminBoundariesMetadata {
  admin_level_1?: string;
  admin_level_2?: string;
  admin_level_3?: string;
}

export interface BiomeMetadata {
  biome_name?: string;
  biome_code?: string;
}
