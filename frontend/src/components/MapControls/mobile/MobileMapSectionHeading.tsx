import type { ReactNode } from "react";

interface MobileMapSectionHeadingProps {
  children: ReactNode;
}

export default function MobileMapSectionHeading({
  children,
}: MobileMapSectionHeadingProps) {
  return (
    <div className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">
      {children}
    </div>
  );
}
