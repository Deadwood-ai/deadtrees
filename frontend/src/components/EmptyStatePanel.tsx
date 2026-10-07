import type { ReactNode } from "react";

interface EmptyStatePanelProps {
  icon: ReactNode;
  /** What the user gains, phrased as an outcome. */
  title: string;
  description: ReactNode;
  action?: ReactNode;
  testId?: string;
}

/** The shared empty state for account lists: outcome title, short explanation, at most one action. */
export default function EmptyStatePanel({ icon, title, description, action, testId }: EmptyStatePanelProps) {
  return (
    <div
      className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-6 py-12 text-center"
      data-testid={testId}
    >
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[#1B5E35]/10 text-xl text-[#1B5E35]" aria-hidden>
        {icon}
      </div>
      <h3 className="m-0 text-base font-semibold text-slate-900">{title}</h3>
      <p className="m-0 mt-1 max-w-md text-sm text-slate-500">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
