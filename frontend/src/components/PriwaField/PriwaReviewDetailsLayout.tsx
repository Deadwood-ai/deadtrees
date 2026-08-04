import { Grid } from "antd";
import type { ReactNode } from "react";

interface PriwaReviewDetailsLayoutProps {
  groupContent: ReactNode;
  treeContent: ReactNode | null;
  isTreeEditing: boolean;
}

const detailPanelClass =
  "pointer-events-auto absolute bottom-5 right-4 top-24 w-[23rem] rounded-xl border border-slate-200 bg-white/95 shadow-xl backdrop-blur";

const adjacentTreePanelClass =
  "pointer-events-auto absolute bottom-5 right-[24.5rem] top-24 w-[22rem] rounded-xl border border-slate-200 bg-white/95 shadow-xl backdrop-blur";

export const getPriwaReviewDetailsLayoutState = (
  isWide: boolean,
  hasTree: boolean,
) => ({
  showGroup: !hasTree || isWide,
  treePlacement: hasTree ? (isWide ? "adjacent" : "detail") : null,
});

export default function PriwaReviewDetailsLayout({
  groupContent,
  treeContent,
  isTreeEditing,
}: PriwaReviewDetailsLayoutProps) {
  const screens = Grid.useBreakpoint();
  const isWide = !!screens.xl;
  const layout = getPriwaReviewDetailsLayoutState(isWide, !!treeContent);

  return (
    <>
      {treeContent && (
        <aside
          id="priwa-review-tree-panel"
          data-priwa-review-tree-panel
          data-testid="priwa-tree-inspector-panel"
          className={`${
            layout.treePlacement === "adjacent"
              ? adjacentTreePanelClass
              : detailPanelClass
          } ${isTreeEditing ? "overflow-hidden" : "overflow-y-auto p-4"}`}
        >
          {treeContent}
        </aside>
      )}

      {layout.showGroup && (
        <aside
          data-priwa-review-detail-panel
          data-testid="priwa-review-detail-panel"
          className={`${detailPanelClass} overflow-y-auto p-4`}
        >
          {groupContent}
        </aside>
      )}
    </>
  );
}
