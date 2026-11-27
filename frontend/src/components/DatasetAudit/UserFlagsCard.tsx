import { useEffect, useRef } from "react";
import { Card, Typography, Tag, Button, message, notification, Popconfirm } from "antd";
import { DatasetFlag, FlagStatus } from "../../types/flags";
import { InlineEmpty, InlineSkeleton } from "../SectionStates";

const { Text } = Typography;

interface UserFlagsCardProps {
	flags: DatasetFlag[];
	isFlagsLoading: boolean;
	isUpdatingFlag: boolean;
	datasetId: number;
	onUpdateFlag: (params: { flag_id: number; dataset_id: number; new_status: FlagStatus; note?: string | null }) => Promise<void>;
}

/** Issues users reported on the dataset, with acknowledge, resolve and reopen (and undo). */
export default function UserFlagsCard({ flags, isFlagsLoading, isUpdatingFlag, datasetId, onUpdateFlag }: UserFlagsCardProps) {
	const latestFlagStatusesRef = useRef(new Map<number, FlagStatus>());
	const undoVersionsRef = useRef(new Map<number, number>());

	const formatStatus = (status: FlagStatus) => status.charAt(0).toUpperCase() + status.slice(1);

	useEffect(() => {
		latestFlagStatusesRef.current = new Map(flags.map((flag) => [flag.id, flag.status]));
	}, [flags]);

	const handleStatusChange = async (flag: DatasetFlag, newStatus: FlagStatus, successMessage: string) => {
		try {
			const previousStatus = flag.status;
			await onUpdateFlag({ flag_id: flag.id, dataset_id: datasetId, new_status: newStatus });
			latestFlagStatusesRef.current.set(flag.id, newStatus);
			const undoVersion = (undoVersionsRef.current.get(flag.id) ?? 0) + 1;
			undoVersionsRef.current.set(flag.id, undoVersion);

			const key = `flag-status-${flag.id}-${Date.now()}`;
			notification.success({
				key,
				message: successMessage,
				description: (
					<Button
						size="small"
						onClick={async () => {
							try {
								if (
									undoVersionsRef.current.get(flag.id) !== undoVersion ||
									latestFlagStatusesRef.current.get(flag.id) !== newStatus
								) {
									notification.destroy(key);
									message.warning("Undo skipped because this issue changed again.");
									return;
								}
								await onUpdateFlag({ flag_id: flag.id, dataset_id: datasetId, new_status: previousStatus });
								latestFlagStatusesRef.current.set(flag.id, previousStatus);
								undoVersionsRef.current.set(flag.id, undoVersion + 1);
								notification.destroy(key);
								message.success(`Issue moved back to ${previousStatus}`);
							} catch {
								message.error("Failed to undo status change");
							}
						}}
					>
						Undo
					</Button>
				),
				duration: 8,
				placement: "topRight",
			});
		} catch {
			message.error("Failed to update flag");
		}
	};

	// `false` would override a disabled audit form (a page without the audit lease);
	// `undefined` lets these actions inherit it.
	const flagActionsDisabled = isUpdatingFlag || undefined;

	const renderFlagActions = (flag: DatasetFlag) => {
		if (flag.status === "open") {
			return (
				<Button
					size="small"
					type="primary"
					onClick={() => handleStatusChange(flag, "acknowledged", "Issue acknowledged")}
					disabled={flagActionsDisabled}
				>
					Acknowledge
				</Button>
			);
		}

		if (flag.status === "acknowledged") {
			return (
				<>
					<Popconfirm
						title="Mark this issue resolved?"
						description="Use this when the report has been handled and should leave the audit queue."
						okText="Mark resolved"
						cancelText="Cancel"
						disabled={flagActionsDisabled}
						onConfirm={() => handleStatusChange(flag, "resolved", "Issue resolved")}
					>
						<Button size="small" type="default" disabled={flagActionsDisabled}>
							Mark resolved
						</Button>
					</Popconfirm>
					<Button
						size="small"
						type="text"
						onClick={() => handleStatusChange(flag, "open", "Issue reopened")}
						disabled={flagActionsDisabled}
					>
						Reopen
					</Button>
				</>
			);
		}

		return (
			<>
				<Button
					size="small"
					type="primary"
					onClick={() => handleStatusChange(flag, "acknowledged", "Issue moved back to acknowledged")}
					disabled={flagActionsDisabled}
				>
					Move to acknowledged
				</Button>
				<Button
					size="small"
					type="text"
					onClick={() => handleStatusChange(flag, "open", "Issue reopened")}
					disabled={flagActionsDisabled}
				>
					Reopen
				</Button>
			</>
		);
	};

	return (
		<Card size="small" className="mb-3 shadow-sm">
			<div className="mb-2 flex items-center justify-between">
				<Text strong className="text-xs">User-reported issues</Text>
				<Text type="secondary" className="text-[11px]">Only visible to auditors and the reporter</Text>
			</div>
			{isFlagsLoading ? (
				<InlineSkeleton label="Loading user-reported issues" className="h-8 w-full" />
			) : flags.length === 0 ? (
				<InlineEmpty>No issues reported by users for this dataset.</InlineEmpty>
			) : (
				<div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
					{flags.map((f) => (
						<Card key={f.id} size="small" className="border-slate-200">
							<div className="mb-1 flex items-center justify-between">
								<div className="space-x-1">
									{f.is_ortho_mosaic_issue && <Tag color="default">Orthomosaic</Tag>}
									{f.is_prediction_issue && <Tag color="default">Segmentation</Tag>}
								</div>
								<Tag color={f.status === "open" ? "red" : f.status === "acknowledged" ? "gold" : "green"}>
									{formatStatus(f.status)}
								</Tag>
							</div>
							{f.reporter_email && (
								<div className="mb-1 text-[11px] text-gray-500">Reporter: {f.reporter_email}</div>
							)}
							<div className="whitespace-pre-wrap text-xs text-gray-700">{f.description}</div>
							<div className="mt-3 flex items-center gap-3">
								{renderFlagActions(f)}
							</div>
						</Card>
					))}
				</div>
			)}
		</Card>
	);
}
