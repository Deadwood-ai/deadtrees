import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export const MIN_PASSWORD_LENGTH = 6;

/** Query string that carries a non-default return path between the auth pages. */
export const returnQuery = (returnTo: string) =>
  returnTo !== "/profile" ? `?returnTo=${encodeURIComponent(returnTo)}` : "";

/** A link in the auth pages' brand green. */
export function AuthLink({
  to,
  children,
}: {
  to: string;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      className="font-medium text-[#1B5E35] underline hover:text-emerald-800"
    >
      {children}
    </Link>
  );
}

interface AuthCardProps {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  /** Links under the card, such as "Already have an account?". */
  footer?: ReactNode;
}

/** The shared frame of the sign-in, sign-up and password pages. */
export default function AuthCard({
  title,
  subtitle,
  children,
  footer,
}: AuthCardProps) {
  return (
    // The page scrolls inside the full-height layout, and the bottom padding
    // grows by the consent banner's height so the form's button never sits
    // underneath it.
    <div className="flex h-full min-h-full w-full items-start justify-center overflow-y-auto px-4 pb-[calc(3rem+var(--dt-consent-inset,0px))] pt-28 md:pt-24">
      <div className="w-full max-w-sm md:my-auto">
        <div className="rounded-2xl border border-gray-200/70 bg-white p-6 shadow-sm sm:p-8">
          <h1 className="m-0 text-2xl font-semibold text-gray-800">{title}</h1>
          {subtitle ? (
            <p className="mb-0 mt-2 text-sm leading-relaxed text-gray-500">
              {subtitle}
            </p>
          ) : null}
          <div className="mt-6">{children}</div>
        </div>
        {footer ? (
          <div className="mt-5 space-y-2 text-center text-sm text-gray-600">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
