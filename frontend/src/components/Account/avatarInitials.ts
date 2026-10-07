// Muted brand-adjacent fills; white initials stay readable on each.
const FILLS = ["#1B5E35", "#287254", "#3F6F8F", "#7A5C2E", "#8A4B5C", "#4F5D75"];

/** Up to two initials from an email's local part, e.g. "anna.mueller@x" -> "AM". */
export function avatarInitials(email: string): string {
  const parts = email.trim().split("@")[0].split(/[._+-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** A stable fill for the same email, so the avatar does not change between visits. */
export function avatarFill(email: string): string {
  let hash = 0;
  for (const char of email.trim().toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return FILLS[hash % FILLS.length];
}
