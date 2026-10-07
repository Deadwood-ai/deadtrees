import { avatarFill, avatarInitials } from "./avatarInitials";

interface AccountAvatarProps {
  email: string;
  size?: number;
}

/** Initials drawn in the browser, so the email never leaves the page. */
export default function AccountAvatar({ email, size = 84 }: AccountAvatarProps) {
  return (
    <div
      role="img"
      aria-label={`Avatar for ${email}`}
      className="flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.38, backgroundColor: avatarFill(email) }}
    >
      {avatarInitials(email)}
    </div>
  );
}
