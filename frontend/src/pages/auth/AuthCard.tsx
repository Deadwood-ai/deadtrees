import type { ReactNode } from "react";

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
    <div className="flex min-h-full w-full items-start justify-center px-4 pb-12 pt-28 md:items-center md:pt-24">
      <div className="w-full max-w-sm">
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
