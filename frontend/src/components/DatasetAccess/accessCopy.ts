import type { DatasetAccessRole } from "../../api/datasetAccess";
import { IDataAccess } from "../../types/dataset";

export interface IVisibilityOption {
  value: IDataAccess;
  label: string;
  description: string;
}

/** The three visibility levels, in the words shown to people choosing between them. */
export const VISIBILITY_OPTIONS: IVisibilityOption[] = [
  {
    value: IDataAccess.public,
    label: "Public",
    description: "Anyone can find, view and download it.",
  },
  {
    value: IDataAccess.viewonly,
    label: "View only",
    description:
      "Anyone can find and view it online and download its predictions. Only you and people you allow can download the orthophoto.",
  },
  {
    value: IDataAccess.private,
    label: "Private",
    description: "Only you and people you share it with can find and view it.",
  },
];

/** Shown under the choice: visibility controls access on the platform, not research use (Terms of Service §5). */
export const VISIBILITY_TRAINING_NOTE =
  "Whichever you choose, your upload helps train the DeadTrees models. Visibility decides who can see and download it here.";

export const visibilityLabel = (value: IDataAccess | string | null | undefined) =>
  VISIBILITY_OPTIONS.find((option) => option.value === value)?.label ?? "Public";

/** Lowering visibility changes access on the platform only; exports made earlier keep the dataset (Terms of Service §4). */
const EXISTING_EXPORTS_NOTE =
  "This dataset may already be part of published data packages and releases, which keep it. Copies people already downloaded stay under the licence they were given.";

/** What an owner should know before saving a lower visibility, or null when access is not reduced. */
export function visibilityReductionNotice(current: IDataAccess | null, next: IDataAccess | undefined): string | null {
  const rank = (value: IDataAccess | null | undefined) => VISIBILITY_OPTIONS.findIndex((option) => option.value === value);
  if (!current || !next || rank(next) <= rank(current)) return null;
  return next === IDataAccess.private
    ? `People you shared the dataset with keep their access; everyone else loses it here. ${EXISTING_EXPORTS_NOTE}`
    : `Only you and people you allow can download the orthophoto from now on. ${EXISTING_EXPORTS_NOTE}`;
}

export interface IRoleOption {
  value: DatasetAccessRole;
  label: string;
  description: string;
}

export const ROLE_OPTIONS: IRoleOption[] = [
  { value: "reader", label: "Reader", description: "Views the dataset online. Downloads only when you allow it." },
  { value: "editor", label: "Editor", description: "Also downloads and edits the dataset's details." },
  { value: "admin", label: "Admin", description: "Also decides who has access." },
];

export const roleLabel = (role: DatasetAccessRole | null | undefined) =>
  ROLE_OPTIONS.find((option) => option.value === role)?.label ?? "Owner";

/** Editors and admins always download; a reader only when the grant allows it. */
export const roleAlwaysDownloads = (role: DatasetAccessRole) => role !== "reader";
