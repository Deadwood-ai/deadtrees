import type { DatasetAccessRole, IMyDatasetAccess } from "../../api/datasetAccess";
import { IDataAccess, type IDataset } from "../../types/dataset";

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

/** How restricted each visibility is; a higher rank means fewer people have access. */
const VISIBILITY_RANK: Record<IDataAccess, number> = {
  [IDataAccess.public]: 0,
  [IDataAccess.viewonly]: 1,
  [IDataAccess.private]: 2,
};

/** What an owner should know before saving a lower visibility, or null when access is not reduced. */
export function visibilityReductionNotice(current: IDataAccess | null, next: IDataAccess | undefined): string | null {
  if (!current || !next || VISIBILITY_RANK[next] <= VISIBILITY_RANK[current]) return null;
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

/**
 * Where the dataset page sends someone to manage or find this dataset; nothing for people
 * without a stake in it, or for the owner of an archived dataset, which My datasets hides.
 */
export function datasetAccountLink(
  access: Pick<IMyDatasetAccess, "is_owner" | "role">,
  dataset: Pick<IDataset, "id" | "archived">,
) {
  if (access.is_owner) {
    return dataset.archived ? null : { to: `/profile?highlight=${dataset.id}`, label: "Manage in My datasets" };
  }
  if (!access.role) return null;
  const label = access.role === "reader" ? "Find in Shared with me" : "Manage in Shared with me";
  return { to: `/profile?tab=shared&highlight=${dataset.id}`, label };
}
