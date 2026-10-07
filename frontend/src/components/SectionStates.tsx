import { Button, Skeleton } from "antd";
import { DisconnectOutlined } from "@ant-design/icons";

import EmptyStatePanel from "./EmptyStatePanel";

// Loading and failure inside a page section (a table, a list), so the rest of
// the page stays usable. Full-page states live in StatusPage.

export function SectionLoadError({
  title,
  onRetry,
  testId,
}: {
  title: string;
  onRetry: () => void;
  testId?: string;
}) {
  return (
    <EmptyStatePanel
      tone="error"
      testId={testId}
      icon={<DisconnectOutlined />}
      title={title}
      description="DeadTrees didn’t respond. Check your connection and try again."
      action={
        <Button type="primary" onClick={onRetry}>
          Try again
        </Button>
      }
    />
  );
}

// Rows of placeholder lines in the shape of a table, instead of a spinner over
// an empty "No data" table.
export function TableSkeleton({
  rows = 5,
  label,
}: {
  rows?: number;
  label: string;
}) {
  return (
    <div
      className="rounded-lg border border-slate-200 bg-white px-6 py-5"
      role="status"
      aria-label={label}
    >
      <Skeleton active title={false} paragraph={{ rows, width: "100%" }} />
    </div>
  );
}
