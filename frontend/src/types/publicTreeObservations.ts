export type PublicTreeCondition = "alive" | "declining" | "dead" | "not_sure";

export type PublicTreeTypeGroup =
  | "conifer"
  | "broadleaf"
  | "palm_or_other"
  | "not_sure";

export interface PublicTreeObservation {
  id: string;
  lat: number;
  lon: number;
  condition: PublicTreeCondition;
  treeTypeGroup: PublicTreeTypeGroup;
  treeTypeText: string | null;
  comment: string | null;
  clientId: string | null;
  createdAt: string;
}

export interface PublicTreeObservationInput {
  lat: number;
  lon: number;
  condition: PublicTreeCondition;
  treeTypeGroup: PublicTreeTypeGroup;
  treeTypeText?: string | null;
  comment?: string | null;
  clientId?: string | null;
}

export const publicTreeConditionOptions: {
  value: PublicTreeCondition;
  label: string;
}[] = [
  { value: "alive", label: "Alive / mostly green" },
  { value: "declining", label: "Dying / partly dead crown" },
  { value: "dead", label: "Dead / brown or grey standing tree" },
  { value: "not_sure", label: "Not sure" },
];

export const publicTreeTypeGroupOptions: {
  value: PublicTreeTypeGroup;
  label: string;
}[] = [
  { value: "conifer", label: "Needleleaf / conifer" },
  { value: "broadleaf", label: "Broadleaf" },
  { value: "palm_or_other", label: "Palm / other" },
  { value: "not_sure", label: "Not sure" },
];

export const publicTreeConditionLabels: Record<PublicTreeCondition, string> =
  Object.fromEntries(
    publicTreeConditionOptions.map((option) => [option.value, option.label]),
  ) as Record<PublicTreeCondition, string>;

export const publicTreeTypeGroupLabels: Record<PublicTreeTypeGroup, string> =
  Object.fromEntries(
    publicTreeTypeGroupOptions.map((option) => [option.value, option.label]),
  ) as Record<PublicTreeTypeGroup, string>;
