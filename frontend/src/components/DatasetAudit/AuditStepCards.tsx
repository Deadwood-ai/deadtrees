import { Card, Typography, Form, Radio, Input, Space, Tooltip, Tag, Button, Image, Collapse, message } from "antd";
import { CopyOutlined, DownloadOutlined, EditOutlined, DeleteOutlined, CloseOutlined, PlusOutlined, SaveOutlined } from "@ant-design/icons";
import { createConditionalRule, formatAcquisitionDate } from "./auditConstants";
import { IDataset } from "../../types/dataset";
import { OrthoMetadata } from "../../hooks/useDatasetAudit";
import { DatasetFlag, FlagStatus } from "../../types/flags";
import { AOIToolbarState, AuditMapWithControlsHandle } from "./AuditMapWithControls";
import type { PhenologyMetadata } from "../../types/phenology";
import PhenologyBar from "../PhenologyBar/PhenologyBar";

const { Text } = Typography;
const { TextArea } = Input;
const { Panel } = Collapse;

// === User Flags Card ===
interface UserFlagsCardProps {
	flags: DatasetFlag[];
	isFlagsLoading: boolean;
	isUpdatingFlag: boolean;
	datasetId: number;
	onUpdateFlag: (params: { flag_id: number; dataset_id: number; new_status: FlagStatus; note?: string | null }) => Promise<void>;
}

export function UserFlagsCard({ flags, isFlagsLoading, isUpdatingFlag, datasetId, onUpdateFlag }: UserFlagsCardProps) {
	const handleAcknowledge = async (flagId: number) => {
		try {
			await onUpdateFlag({ flag_id: flagId, dataset_id: datasetId, new_status: "acknowledged" });
			message.success("Flag acknowledged");
		} catch {
			message.error("Failed to update flag");
		}
	};

	const handleResolve = async (flagId: number) => {
		try {
			await onUpdateFlag({ flag_id: flagId, dataset_id: datasetId, new_status: "resolved" });
			message.success("Flag resolved");
		} catch {
			message.error("Failed to update flag");
		}
	};

	return (
		<Card size="small" className="mb-3 shadow-sm">
			<div className="mb-2 flex items-center justify-between">
				<Text strong className="text-xs">User-reported issues</Text>
				<Text type="secondary" className="text-[11px]">Only visible to auditors and the reporter</Text>
			</div>
			{isFlagsLoading ? (
				<div className="text-xs text-gray-500">Loading flags...</div>
			) : flags.length === 0 ? (
				<div className="text-xs text-gray-500">No issues reported by users for this dataset.</div>
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
									{f.status.charAt(0).toUpperCase() + f.status.slice(1)}
								</Tag>
							</div>
							{f.reporter_email && (
								<div className="mb-1 text-[11px] text-gray-500">Reporter: {f.reporter_email}</div>
							)}
							<div className="whitespace-pre-wrap text-xs text-gray-700">{f.description}</div>
							<div className="mt-3 flex items-center gap-3">
								<Button
									size="small"
									type="primary"
									onClick={() => handleAcknowledge(f.id)}
									disabled={f.status !== "open" || isUpdatingFlag}
								>
									Acknowledge
								</Button>
								<Button
									size="small"
									type="default"
									onClick={() => handleResolve(f.id)}
									disabled={isUpdatingFlag}
								>
									Resolve
								</Button>
							</div>
						</Card>
					))}
				</div>
			)}
		</Card>
	);
}

// === Georeferencing Card (Step 1) ===
export function GeoreferencingCard() {
	return (
		<Card size="small" className="mb-3 shadow-sm">
			<div className="mb-2 flex items-center">
				<Text strong className="text-xs">1. Georeferencing Accuracy</Text>
			</div>
			<Form.Item
				name="is_georeferenced"
				className="mb-0"
				rules={createConditionalRule("Please assess georeferencing")}
			>
				<Radio.Group>
					<Space size="large">
						<Radio value={true}>🟢 Good (&lt;15m)</Radio>
						<Radio value={false}>🔴 Poor (&gt;15m)</Radio>
					</Space>
				</Radio.Group>
			</Form.Item>
		</Card>
	);
}

// === Acquisition Date Card (Step 2) ===
interface AcquisitionDateCardProps {
	dataset: IDataset;
}

export function AcquisitionDateCard({ dataset }: AcquisitionDateCardProps) {
	return (
		<Card size="small" className="mb-3 shadow-sm">
			<div className="mb-2 flex items-center">
				<Text strong className="text-xs">2. Acquisition Date</Text>
			</div>
			<div className="mb-2 text-xs">
				<Text type="secondary">Reported date: </Text>
				<Text strong>{formatAcquisitionDate(dataset)}</Text>
			</div>
			<Form.Item
				name="has_valid_acquisition_date"
				className="mb-2"
				rules={createConditionalRule("Please validate acquisition date")}
			>
				<Radio.Group>
					<Space size="large">
						<Radio value={true}>🟢 Valid</Radio>
						<Radio value={false}>🔴 Invalid</Radio>
					</Space>
				</Radio.Group>
			</Form.Item>
			<Form.Item name="acquisition_date_notes" className="mb-0">
				<TextArea rows={2} placeholder="Date notes..." className="text-xs" />
			</Form.Item>
		</Card>
	);
}

// === Phenology Card (Step 3) ===
interface PhenologyCardProps {
	dataset: IDataset;
	phenologyData: PhenologyMetadata | null | undefined;
	isPhenologyLoading: boolean;
	onCopySeasonPrompt: () => void;
}

export function PhenologyCard({ dataset, phenologyData, isPhenologyLoading, onCopySeasonPrompt }: PhenologyCardProps) {
	return (
		<Card size="small" className="mb-3 shadow-sm">
			<div className="mb-2 flex items-center justify-between">
				<div className="flex items-center">
					<Text strong className="text-xs">3. Phenology / Season</Text>
				</div>
			</div>

			{/* Phenology bar */}
			{isPhenologyLoading ? (
				<div className="mb-2 text-xs text-gray-500">Loading phenology data...</div>
			) : phenologyData?.phenology_curve ? (
				<div className="mb-8 mt-3 overflow-visible">
					<PhenologyBar
						phenologyData={phenologyData}
						acquisitionYear={dataset.aquisition_year}
						acquisitionMonth={dataset.aquisition_month}
						acquisitionDay={dataset.aquisition_day}
						showTooltips={true}
					/>
				</div>
			) : (
				<div className="mb-2 text-xs text-gray-500">No phenology data available</div>
			)}

			{/* AI prompt button */}
			<div className="mb-2">
				<Tooltip title="Copy AI classification prompt to clipboard (with thumbnail image if supported)">
					<Button
						size="small"
						icon={<CopyOutlined />}
						onClick={onCopySeasonPrompt}
					>
						Copy AI Prompt
					</Button>
				</Tooltip>
			</div>

			<Form.Item
				name="has_valid_phenology"
				className="mb-2"
				rules={createConditionalRule("Please assess phenology")}
			>
				<Radio.Group>
					<Space size="large">
						<Radio value={true}>🟢 In Season</Radio>
						<Radio value={false}>🔴 Out of Season</Radio>
					</Space>
				</Radio.Group>
			</Form.Item>

			<Form.Item name="phenology_notes" className="mb-0">
				<TextArea rows={2} placeholder="Seasonal observations..." className="text-xs" />
			</Form.Item>
		</Card>
	);
}

// === Prediction Quality Card (Step 4) ===
export function PredictionQualityCard() {
	return (
		<Card size="small" className="mb-3 shadow-sm">
			<div className="mb-2 flex items-center">
				<Text strong className="text-xs">4. Prediction Quality</Text>
			</div>

			{/* Deadwood */}
			<div className="mb-3">
				<div className="mb-1 flex items-center">
					<Text className="text-xs font-medium">Deadwood Segmentation</Text>
				</div>
				<Form.Item
					name="deadwood_quality"
					className="mb-1"
					rules={createConditionalRule("Please rate deadwood quality")}
				>
					<Radio.Group>
						<Space size="large">
							<Radio value="great">🟢 Great</Radio>
							<Radio value="sentinel_ok">🟡 OK</Radio>
							<Radio value="bad">🔴 Bad</Radio>
						</Space>
					</Radio.Group>
				</Form.Item>
				<Form.Item name="deadwood_notes" className="mb-0">
					<TextArea rows={1} placeholder="Deadwood notes..." className="text-xs" />
				</Form.Item>
			</div>

			{/* Forest Cover */}
			<div>
				<div className="mb-1 flex items-center">
					<Text className="text-xs font-medium">Forest Cover Segmentation</Text>
				</div>
				<Form.Item
					name="forest_cover_quality"
					className="mb-1"
					rules={[{ required: false, message: "Please rate forest cover quality" }]}
				>
					<Radio.Group>
						<Space size="large">
							<Radio value="great">🟢 Great</Radio>
							<Radio value="sentinel_ok">🟡 OK</Radio>
							<Radio value="bad">🔴 Bad</Radio>
						</Space>
					</Radio.Group>
				</Form.Item>
				<Form.Item name="forest_cover_notes" className="mb-0">
					<TextArea rows={1} placeholder="Forest cover notes..." className="text-xs" />
				</Form.Item>
			</div>
		</Card>
	);
}

// === COG Quality Card (Step 5) ===
export function COGQualityCard() {
	return (
		<Card size="small" className="mb-3 shadow-sm">
			<div className="mb-2 flex items-center">
				<Text strong className="text-xs">5. Cloud-Optimized GeoTIFF</Text>
			</div>

			<Form.Item
				name="has_cog_issue"
				className="mb-2"
				rules={createConditionalRule("Please assess COG quality")}
			>
				<Radio.Group>
					<Space size="large">
						<Radio value={false}>🟢 Good</Radio>
						<Radio value={true}>🔴 Issues</Radio>
					</Space>
				</Radio.Group>
			</Form.Item>

			<Form.Item name="cog_issue_notes" className="mb-0">
				<TextArea
					rows={2}
					placeholder="COG issue details (transparency, black/white areas, color bands, artifacts)..."
					className="text-xs"
				/>
			</Form.Item>
		</Card>
	);
}

// === Thumbnail Card (Step 6) ===
interface ThumbnailCardProps {
	thumbnailUrl: string | null;
}

export function ThumbnailCard({ thumbnailUrl }: ThumbnailCardProps) {
	return (
		<Card size="small" className="mb-3 shadow-sm">
			<div className="mb-2 flex items-center">
				<Text strong className="text-xs">6. Thumbnail</Text>
			</div>

			{thumbnailUrl && (
				<div className="mb-3 flex justify-center">
					<Image
						src={thumbnailUrl}
						alt="Dataset thumbnail"
						width={120}
						height={120}
						style={{ objectFit: "cover" }}
						className="rounded border"
						fallback="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
					/>
				</div>
			)}

			<Form.Item
				name="has_thumbnail_issue"
				className="mb-2"
				rules={createConditionalRule("Please assess thumbnail quality")}
			>
				<Radio.Group>
					<Space size="large">
						<Radio value={false}>🟢 Good</Radio>
						<Radio value={true}>🔴 Issues</Radio>
					</Space>
				</Radio.Group>
			</Form.Item>

			<Form.Item name="thumbnail_issue_notes" className="mb-0">
				<TextArea
					rows={2}
					placeholder="Thumbnail issue details (colors, zoom level, white background, artifacts)..."
					className="text-xs"
				/>
			</Form.Item>
		</Card>
	);
}

// === AOI Card (Step 7) ===
interface AOICardProps {
	aoiToolbarState: AOIToolbarState;
	mapRef: React.RefObject<AuditMapWithControlsHandle>;
}

export function AOICard({ aoiToolbarState, mapRef }: AOICardProps) {
	return (
		<Card size="small" className="mb-3 shadow-sm">
			<div className="mb-2 flex items-center">
				<Text strong className="text-xs">7. Area of Interest (AOI)</Text>
			</div>

			{/* AOI Status */}
			{aoiToolbarState.isAOILoading ? (
				<div className="text-xs text-gray-500">Loading AOI...</div>
			) : (
				<div className="space-y-2">
					{/* Status indicator */}
					{aoiToolbarState.hasAOI && !aoiToolbarState.isDrawing && !aoiToolbarState.isEditing && (
						<div className="rounded bg-green-50 px-2 py-1 text-xs text-green-700">
							✓ AOI defined ({aoiToolbarState.polygonCount} polygon{aoiToolbarState.polygonCount !== 1 ? "s" : ""})
						</div>
					)}

					{/* Toolbar buttons based on state */}
					{!aoiToolbarState.isDrawing && !aoiToolbarState.isEditing && !aoiToolbarState.hasAOI && (
						<Button
							icon={<PlusOutlined />}
							onClick={() => mapRef.current?.startDrawing()}
							size="small"
						>
							Draw AOI Polygon
						</Button>
					)}

					{aoiToolbarState.isDrawing && (
						<div className="flex gap-2">
							<Button
								icon={<CloseOutlined />}
								onClick={() => mapRef.current?.cancelDrawing()}
								size="small"
							>
								Cancel Drawing
							</Button>
						</div>
					)}

					{!aoiToolbarState.isDrawing && !aoiToolbarState.isEditing && aoiToolbarState.hasAOI && (
						<div className="flex flex-wrap gap-2">
							<Button
								icon={<EditOutlined />}
								onClick={() => mapRef.current?.startEditing()}
								size="small"
							>
								Edit
							</Button>
							<Button
								icon={<PlusOutlined />}
								onClick={() => mapRef.current?.addAnotherPolygon()}
								size="small"
							>
								Add
							</Button>
							<Button
								icon={<DeleteOutlined />}
								onClick={() => mapRef.current?.deleteAOI()}
								size="small"
								danger
							>
								Delete All
							</Button>
						</div>
					)}

					{aoiToolbarState.isEditing && (
						<div className="space-y-2">
							<div className="text-xs text-gray-500">Click polygon to select, drag vertices to modify</div>
							<div className="flex flex-wrap gap-2">
								<Button
									icon={<SaveOutlined />}
									onClick={() => mapRef.current?.saveEditing()}
									size="small"
									type="primary"
								>
									Save
								</Button>
								<Button
									icon={<CloseOutlined />}
									onClick={() => mapRef.current?.cancelEditing()}
									size="small"
								>
									Cancel
								</Button>
								{aoiToolbarState.selectedFeatureForEdit && (
									<Button
										icon={<DeleteOutlined />}
										onClick={() => mapRef.current?.deleteSelectedPolygon()}
										size="small"
										danger
									>
										Delete
									</Button>
								)}
							</div>
						</div>
					)}
				</div>
			)}

			{/* AOI requirement status */}
			<Form.Item
				shouldUpdate={(prevValues, currentValues) =>
					prevValues.final_assessment !== currentValues.final_assessment
				}
				className="mb-0 mt-2"
			>
				{({ getFieldValue }) => {
					const assessment = getFieldValue("final_assessment");
					const aoiRequired = assessment === "no_issues";

					if (aoiToolbarState.hasAOI) return null;

					return (
						<div className="text-xs">
							{aoiRequired ? (
								<div className="text-orange-600">AOI required for "Ready" assessment</div>
							) : (
								<div className="text-gray-500">AOI optional for this assessment</div>
							)}
						</div>
					);
				}}
			</Form.Item>
		</Card>
	);
}

// === Final Assessment Card (Step 8) ===
interface FinalAssessmentCardProps {
	dataset: IDataset;
	orthoMetadata: OrthoMetadata | null | undefined;
	isOrthoLoading: boolean;
	isDownloading: boolean;
	currentDownloadId: string | null;
	onStartDownload: (dataset: IDataset) => void;
}

export function FinalAssessmentCard({
	dataset,
	orthoMetadata,
	isOrthoLoading,
	isDownloading,
	currentDownloadId,
	onStartDownload,
}: FinalAssessmentCardProps) {
	const isViewOnlyDataset = dataset.data_access === "viewonly";

	return (
		<Card size="small" className="mb-3 shadow-sm">
			<div className="mb-2 flex items-center">
				<Text strong className="text-xs">8. Final Assessment</Text>
			</div>

			<Form.Item
				name="final_assessment"
				className="mb-2"
				rules={[{ required: true, message: "Please select final assessment" }]}
			>
				<Radio.Group>
					<Space direction="horizontal" size="small">
						<Radio value="no_issues">🟢 Ready</Radio>
						<Radio value="fixable_issues">🟡 Fixable</Radio>
						<Radio value="exclude_completely">🔴 Exclude</Radio>
					</Space>
				</Radio.Group>
			</Form.Item>

			{/* Technical Metadata */}
			<div className="mb-3">
				{isOrthoLoading ? (
					<div className="text-xs text-gray-500">Loading metadata...</div>
				) : orthoMetadata?.ortho_info ? (
					<Collapse size="small">
						<Panel header="📋 Technical Metadata" key="1">
							<div className="max-h-32 overflow-y-auto">
								<pre className="whitespace-pre-wrap rounded bg-gray-50 p-2 text-xs">
									{JSON.stringify(orthoMetadata.ortho_info, null, 2)}
								</pre>
							</div>
						</Panel>
					</Collapse>
				) : (
					<div className="text-xs text-gray-500">No technical metadata available</div>
				)}
			</div>

			{/* Download button */}
			<div className="mb-3">
				<Tooltip
					title={
						isViewOnlyDataset
							? "View-only dataset: orthophoto download is restricted"
							: "Download orthophoto for local testing"
					}
				>
					<Button
						size="small"
						icon={<DownloadOutlined />}
						disabled={isDownloading || isViewOnlyDataset}
						loading={isDownloading && currentDownloadId === `${dataset.id}-ortho`}
						onClick={() => onStartDownload(dataset)}
					>
						Download Orthophoto
					</Button>
				</Tooltip>
			</div>

			{/* Notes */}
			<Form.Item name="notes" className="mb-0">
				<TextArea rows={3} placeholder="Additional observations..." className="text-xs" />
			</Form.Item>
		</Card>
	);
}
