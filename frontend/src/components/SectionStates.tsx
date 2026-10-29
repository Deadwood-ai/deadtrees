import type { ReactNode } from "react";
import { Button, Skeleton } from "antd";
import { DisconnectOutlined } from "@ant-design/icons";

import EmptyStatePanel from "./EmptyStatePanel";
import { useSlowLoading } from "../hooks/useSlowLoading";

// Loading, empty and failure inside a page section (a table, a list, a card)
// or around a single value, so the rest of the page stays usable. Whole-page
// states live in PageSkeletons and StatusPage.
//
// The rules: loading shows the shape of what is coming, never "Loading…" text
// (the label is for screen readers); a long wait explains itself; a failed
// load offers a retry in place, never a toast.

export const SLOW_LOADING_MESSAGE =
  "This is taking longer than usual. DeadTrees may be busy; we keep trying.";

const NO_RESPONSE = "DeadTrees didn’t respond. Check your connection and try again.";

/** Appears once a wait passes eight seconds; renders nothing before. */
export function SlowLoadingNote({ className = "" }: { className?: string }) {
  const slow = useSlowLoading();
  if (!slow) return null;
  return (
    <p className={`m-0 text-center text-sm text-slate-500 ${className}`} aria-live="polite">
      {SLOW_LOADING_MESSAGE}
    </p>
  );
}

/** A section that failed to load: what is missing, why, and one retry. */
export function SectionLoadError({
  title,
  onRetry,
  description = NO_RESPONSE,
  testId,
}: {
  title: string;
  onRetry: () => void;
  description?: ReactNode;
  testId?: string;
}) {
  return (
    <EmptyStatePanel
      tone="error"
      testId={testId}
      icon={<DisconnectOutlined />}
      title={title}
      description={description}
      action={
        <Button type="primary" onClick={onRetry}>
          Try again
        </Button>
      }
    />
  );
}

/** Placeholder lines for a section that already has its own frame (a card, a modal). */
export function SectionSkeleton({ rows = 5, label }: { rows?: number; label: string }) {
  return (
    <div className="flex flex-col gap-3" role="status" aria-label={label}>
      <Skeleton active title={false} paragraph={{ rows, width: "100%" }} />
      <SlowLoadingNote />
    </div>
  );
}

// Rows of placeholder lines in the shape of a table, instead of a spinner over
// an empty "No data" table.
export function TableSkeleton({ rows = 5, label }: { rows?: number; label: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-6 py-5">
      <SectionSkeleton rows={rows} label={label} />
    </div>
  );
}

/** Placeholder list entries: thumbnail, title, one line of details. */
export function ListSkeleton({ rows = 6, label }: { rows?: number; label: string }) {
  return (
    <div className="flex flex-col gap-4 px-1 pt-2" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton
          key={index}
          active
          avatar={{ shape: "square", size: 48 }}
          title={{ width: "70%" }}
          paragraph={{ rows: 1, width: "45%" }}
        />
      ))}
      <SlowLoadingNote />
    </div>
  );
}

/** One shimmer bar the size of the value it stands in for. */
export function InlineSkeleton({ label, className = "h-4 w-24" }: { label: string; className?: string }) {
  return (
    <span
      className={`inline-block animate-pulse rounded bg-slate-200 align-middle motion-reduce:animate-none ${className}`}
      role="status"
      aria-label={label}
    />
  );
}

/** A small panel or value with nothing to show yet. */
export function InlineEmpty({ children }: { children: ReactNode }) {
  return <p className="m-0 rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-500">{children}</p>;
}

/** A small panel or value that failed to load, with a retry link. */
export function InlineLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <p className="m-0 text-sm text-red-600" role="alert">
      {message}{" "}
      <Button type="link" size="small" className="!h-auto !p-0 align-baseline" onClick={onRetry}>
        Retry
      </Button>
    </p>
  );
}
