import { useState, type ReactNode } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Alert, Button } from "antd";
import { useAuth } from "../hooks/useAuthProvider";
import { useCanAudit, useCanOperate } from "../hooks/useUserPrivileges";
import { useDatasetById } from "../hooks/useDatasets";
import DatasetAuditDetail from "../components/DatasetAudit/DatasetAuditDetail";
import DatasetEditsFlags from "../components/DatasetAudit/edits/DatasetEditsFlags";
import type { IDataset } from "../types/dataset";
import AuditReviewList from "../components/DatasetAudit/list/AuditReviewList";
import StatusPage from "../components/StatusPage";
import { MapPageSkeleton, PageSkeleton } from "../components/PageSkeletons";

// The processing view moved to the Factory workspace; the old tab link is still handled.
const LEGACY_PROCESSING_TAB = "processing";

// A review opens on a map; the list is a table page.
function AuditLoading({ id }: { id?: string }) {
	return id ? <MapPageSkeleton label="Loading dataset" /> : <PageSkeleton label="Loading the Audit Review" />;
}

/** /dataset-audit, /dataset-audit/:id and /dataset-audit/:id/edits-flags: the Audit Review list,
 * one dataset's review, and one dataset's edits and user reports (not part of the audit), for auditors. */
export default function DatasetAudit({ page = "review" }: { page?: "review" | "edits-flags" }) {
	const navigate = useNavigate();
	const { id } = useParams();
	const { user, status: authStatus } = useAuth();
	const { canAudit, isLoading, isError, refetch } = useCanAudit();

	// Privileges are only fetched once the session check knows the user.
	if (authStatus === "checking" || isLoading) return <AuditLoading id={id} />;

	if (isError) {
		return (
			<StatusPage
				kind="offline"
				title="The Audit Review couldn’t load"
				description="DeadTrees didn’t respond while checking your access. Check your connection and try again in a moment."
				actions={
					<Button type="primary" onClick={() => void refetch()}>
						Try again
					</Button>
				}
			/>
		);
	}

	if (!user || !canAudit) {
		return (
			<StatusPage
				kind="locked"
				title="Auditor access needed"
				description="The Audit Review is for the DeadTrees audit team. Ask the team if you should have access."
				actions={
					<>
						<Button type="primary" onClick={() => navigate("/dataset")}>
							Browse the drone archive
						</Button>
						<Button onClick={() => navigate("/")}>Go to home</Button>
					</>
				}
			/>
		);
	}

	if (!id) return <AuditReviewListPage />;
	return page === "edits-flags" ? <WithDataset id={id}>{(dataset) => <DatasetEditsFlags dataset={dataset} />}</WithDataset> : <AuditReviewDetail id={id} />;
}

function AuditReviewDetail({ id }: { id: string }) {
	return <WithDataset id={id}>{(dataset) => <DatasetAuditDetail dataset={dataset} />}</WithDataset>;
}

/** The dataset of an audit page, or why it isn't there. */
function WithDataset({ id, children }: { id: string; children: (dataset: IDataset) => ReactNode }) {
	const navigate = useNavigate();
	const { data: dataset, isLoading, isError, refetch } = useDatasetById(Number(id));
	if (isLoading) return <MapPageSkeleton label="Loading dataset" />;
	// A failed background refetch must not unmount a review in progress.
	if (isError && !dataset) {
		return (
			<StatusPage
				kind="offline"
				title="This dataset couldn’t load"
				description="DeadTrees didn’t respond. Check your connection and try again in a moment."
				actions={
					<Button type="primary" onClick={() => refetch()}>
						Try again
					</Button>
				}
			/>
		);
	}
	if (!dataset) {
		return (
			<StatusPage
				kind="not-found"
				title="Dataset not found"
				description={`There is no dataset ${id} to review.`}
				actions={<Button onClick={() => navigate("/dataset-audit")}>Back to the Audit Review</Button>}
			/>
		);
	}
	return <>{children(dataset)}</>;
}

function AuditReviewListPage() {
	const [searchParams] = useSearchParams();
	// the list rewrites the URL to its own tab: remember where the visitor came from
	const [processingLink] = useState(() => searchParams.get("tab") === LEGACY_PROCESSING_TAB);
	const { canOperate, isLoading } = useCanOperate();
	if (!processingLink) return <AuditReviewList />;
	if (isLoading) return <PageSkeleton label="Loading the Audit Review" />;
	if (canOperate) return <Navigate replace to="/factory" />;
	return (
		<AuditReviewList
			notice={
				<Alert
					type="info"
					showIcon
					className="mb-6"
					message="Processing moved to the Factory workspace"
					description="The processing view now lives in the Factory workspace, which needs operator access. Ask the team if you need it."
					data-testid="audit-processing-moved"
				/>
			}
		/>
	);
}
