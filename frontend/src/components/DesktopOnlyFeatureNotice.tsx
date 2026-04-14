import { LaptopOutlined } from "@ant-design/icons";
import type { ReactNode } from "react";

interface DesktopOnlyFeatureNoticeProps {
  title: string;
  description: string;
  actions?: ReactNode;
  className?: string;
}

export default function DesktopOnlyFeatureNotice({
  title,
  description,
  actions,
  className = "",
}: DesktopOnlyFeatureNoticeProps) {
  return (
    <div className={`rounded-2xl border border-slate-200 bg-white p-5 shadow-sm ${className}`.trim()}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-600">
          <LaptopOutlined />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="m-0 text-base font-semibold text-slate-900">{title}</h3>
          <p className="mb-0 mt-2 text-sm leading-6 text-slate-600">{description}</p>
          {actions ? <div className="mt-4 flex flex-wrap gap-3">{actions}</div> : null}
        </div>
      </div>
    </div>
  );
}
