import type { ReactNode } from "react";

interface EmptyStatePanelProps {
  icon: ReactNode;
  /** What the user gains, phrased as an outcome. */
  title: string;
  description: ReactNode;
  action?: ReactNode;
  testId?: string;
  /** "error" marks a list that failed to load rather than one that is empty. */
  tone?: "neutral" | "error";
}

/** The shared empty or failed state for lists: outcome title, short explanation, at most one action. */
export default function EmptyStatePanel({ icon, title, description, action, testId, tone = "neutral" }: EmptyStatePanelProps) {
  const iconTone = tone === "error" ? "bg-red-50 text-red-500" : "bg-[#1B5E35]/10 text-[#1B5E35]";
  return (
    <div
      className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-6 py-12 text-center"
      data-testid={testId}
    >
      <div className={`mb-4 flex h-12 w-12 items-center justify-center rounded-full text-xl ${iconTone}`} aria-hidden>
        {icon}
      </div>
      <h3 className="m-0 text-base font-semibold text-slate-900">{title}</h3>
      <p className="m-0 mt-1 max-w-md text-sm text-slate-500">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
