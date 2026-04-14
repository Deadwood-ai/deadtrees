import { forwardRef } from "react";
import { Card, Button, Tag, Typography, Space } from "antd";
import { EditOutlined, CloseOutlined, CheckOutlined, UndoOutlined } from "@ant-design/icons";

const { Text } = Typography;

export interface ClickedPolygonInfo {
	type: string;
	status: string;
	layerType: "deadwood" | "forest_cover";
	correctionId?: number;
	geometryId?: number;
	correctionOperation?: string; // 'create', 'modify', 'delete'
}

interface FeaturePopoverProps {
	info: ClickedPolygonInfo | null;
	isVisible: boolean;
	isLoggedIn: boolean;
	canReviewCorrections?: boolean;
	onClose: () => void;
	onEdit?: () => void;
	onApproveCorrection?: (correctionId: number, geometryId: number) => void;
	onRevertCorrection?: (correctionId: number, geometryId: number) => void;
}

/**
 * Interactive popover for clicked map features
 * Shows feature details and action buttons
 */
const FeaturePopover = forwardRef<HTMLDivElement, FeaturePopoverProps>(
	(
		{
			info,
			isVisible,
			isLoggedIn,
			canReviewCorrections = false,
			onClose,
			onEdit,
			onApproveCorrection,
			onRevertCorrection,
		},
		ref
	) => {
		if (!isVisible || !info) {
			return <div ref={ref} style={{ display: "none" }} />;
		}

		const getStatusColor = () => {
			if (info.status === "original") return "default";
			if (info.status === "pending") {
				return info.correctionOperation === "delete" ? "error" : "warning";
			}
			return "success";
		};

		const getStatusLabel = () => {
			if (info.status === "original") return "Prediction";
			if (info.status === "pending") {
				switch (info.correctionOperation) {
					case "create": return "Added";
					case "delete": return "Deleted";
					case "modify": return "Modified";
					default: return "Edited";
				}
			}
			return "Verified";
		};

		const getDescription = () => {
			if (info.status === "original") {
				return "This is a model prediction. Help improve accuracy by editing.";
			}
			if (info.status === "pending") {
				switch (info.correctionOperation) {
					case "create": return "This polygon has been added and is awaiting review.";
					case "delete": return "This polygon has been marked for deletion and is awaiting review.";
					case "modify": return "This polygon has been modified and is awaiting review.";
					default: return "This polygon has been edited and is awaiting review.";
				}
			}
			return "This polygon has been verified and is considered accurate.";
		};

		return (
			<div ref={ref} style={{ display: "block" }}>
				<Card
					size="small"
					className="shadow-xl border-gray-100"
					style={{ width: 220, borderRadius: 8, overflow: "hidden" }}
					title={
						<Space size={4}>
							<Text strong style={{ fontSize: "12px" }}>{info.type}</Text>
							<Tag
								color={getStatusColor()}
								className="m-0 text-[10px] leading-4 h-4 px-1 border-none"
							>
								{getStatusLabel()}
							</Tag>
						</Space>
					}
					extra={
						<Button
							type="text"
							size="small"
							className="p-0 h-4 w-4 flex items-center justify-center text-gray-400 hover:text-gray-600"
							icon={<CloseOutlined style={{ fontSize: 10 }} />}
							onClick={onClose}
						/>
					}
					bodyStyle={{ padding: "10px 12px" }}
				>
					<div className="flex flex-col gap-3">
						<Text type="secondary" style={{ fontSize: "11px", lineHeight: "1.4" }}>
							{getDescription()}
						</Text>

						{/* Correction Review Actions (for auditors reviewing pending edits) */}
						{canReviewCorrections &&
							info.status === "pending" &&
							info.correctionId &&
							info.geometryId && (
								<div className="flex gap-2">
									<Button
										type="primary"
										size="small"
										icon={<CheckOutlined style={{ fontSize: 11 }} />}
										onClick={() => {
											onApproveCorrection?.(info.correctionId!, info.geometryId!);
											onClose();
										}}
										className="text-xs h-7 flex-1"
									>
										Approve
									</Button>
									<Button
										danger
										size="small"
										icon={<UndoOutlined style={{ fontSize: 11 }} />}
										onClick={() => {
											onRevertCorrection?.(info.correctionId!, info.geometryId!);
											onClose();
										}}
										className="text-xs h-7 flex-1"
									>
										Revert
									</Button>
								</div>
							)}

						{/* Edit Action (for logged-in users) */}
						{isLoggedIn ? (
							<Button
								type="primary"
								size="small"
								block
								icon={<EditOutlined style={{ fontSize: 11 }} />}
								onClick={() => {
									onClose();
									onEdit?.();
								}}
								className="text-xs h-8 font-medium"
							>
								Edit {info.type}
							</Button>
						) : (
							<Button
								type="default"
								size="small"
								block
								href="/sign-in"
								className="text-xs h-8"
							>
								Sign in to edit
							</Button>
						)}
					</div>
				</Card>
			</div>
		);
	}
);

FeaturePopover.displayName = "FeaturePopover";

export default FeaturePopover;
