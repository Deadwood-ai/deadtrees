import type { ReactNode } from "react";
import {
  CloudSyncOutlined,
  DisconnectOutlined,
  LockOutlined,
  SearchOutlined,
  WarningOutlined,
} from "@ant-design/icons";

export type StatusPageKind =
  "not-found" | "locked" | "error" | "offline" | "updated";

const KIND_ICON: Record<StatusPageKind, { icon: ReactNode; tone: string }> = {
  "not-found": {
    icon: <SearchOutlined />,
    tone: "bg-slate-100 text-slate-500",
  },
  locked: { icon: <LockOutlined />, tone: "bg-amber-50 text-amber-600" },
  error: { icon: <WarningOutlined />, tone: "bg-red-50 text-red-500" },
  offline: {
    icon: <DisconnectOutlined />,
    tone: "bg-slate-100 text-slate-500",
  },
  updated: {
    icon: <CloudSyncOutlined />,
    tone: "bg-emerald-50 text-emerald-700",
  },
};

// The navigation floats over the page, so full-page states keep clear of it
// and fill the viewport; the footer then stays at the bottom instead of
// floating halfway up the screen.
const SHELL =
  "flex w-full items-center justify-center bg-[var(--dt-surface-base)] px-4 pb-12 pt-28";

interface StatusPageProps {
  kind: StatusPageKind;
  title: string;
  description: ReactNode;
  actions?: ReactNode;
}

// One shape for every full-page state that is not the page itself:
// not found, no access, failed to load, offline and "a new version is out".
// Pages on their way use PageSkeleton or MapPageSkeleton instead.
export default function StatusPage({
  kind,
  title,
  description,
  actions,
}: StatusPageProps) {
  const { icon, tone } = KIND_ICON[kind];
  return (
    <div
      className={`${SHELL} min-h-[calc(100dvh-3rem)]`}
      data-testid={`status-page-${kind}`}
    >
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white px-6 py-8 text-center shadow-sm sm:px-10">
        <div
          className={`mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full text-2xl ${tone}`}
        >
          {icon}
        </div>
        <h1 className="m-0 text-xl font-semibold text-slate-900">{title}</h1>
        <div className="mt-2 text-sm leading-6 text-slate-600">
          {description}
        </div>
        {actions && (
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}
