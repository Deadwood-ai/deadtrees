export type FlagStatus = "open" | "acknowledged" | "resolved";

export interface DatasetFlag {
  id: number;
  dataset_id: number;
  created_by: string; // uuid
  is_ortho_mosaic_issue: boolean;
  is_prediction_issue: boolean;
  description: string;
  status: FlagStatus;
  reporter_email?: string | null;
  auditor_comment?: string | null;
  resolved_by?: string | null; // uuid
  created_at: string; // ISO timestamp
  updated_at: string; // ISO timestamp
}

export interface DatasetFlagHistory {
  id: number;
  flag_id: number;
  old_status: FlagStatus | null;
  new_status: FlagStatus;
  changed_by: string; // uuid
  note?: string | null;
  changed_at: string; // ISO timestamp
}
