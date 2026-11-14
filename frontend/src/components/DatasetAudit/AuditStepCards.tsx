import { Fragment, useEffect, useRef } from "react";
import { Card, Typography, Form, Radio, Input, Space, Tooltip, Tag, Button, Image, Collapse, message, notification, Popconfirm } from "antd";
import {
	CopyOutlined,
	DownloadOutlined,
} from "@ant-design/icons";
import { createConditionalRule } from "./auditConstants";
import { imageFacts } from "../../utils/imageFacts";
import NoteField from "./checks/NoteField";
import type { IAuditSuggestion } from "../../types/acquisitionDate";
import { SuggestedTag } from "./AcquisitionDateCard";
import { IDataset } from "../../types/dataset";
import { OrthoMetadata } from "../../hooks/useDatasetAudit";
import { DatasetFlag, FlagStatus } from "../../types/flags";
import type { PhenologyMetadata } from "../../types/phenology";
import PhenologyBar from "../PhenologyBar/PhenologyBar";
import { InlineEmpty, InlineSkeleton } from "../SectionStates";

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

	// nothing reported: no box; it appears as soon as a user reports something
	if (!isFlagsLoading && flags.length === 0) return null;

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

// === Phenology (manual) ===
interface PhenologyCardProps {
	dataset: IDataset;
	phenologyData: PhenologyMetadata | null | undefined;
	isPhenologyLoading: boolean;
	onCopySeasonPrompt: () => void;
}

export function PhenologyCard({ dataset, phenologyData, isPhenologyLoading, onCopySeasonPrompt }: PhenologyCardProps) {
	return (
		<div>
			<div className="mb-1 text-xs text-gray-600">Manual for now: answer leaf-on or leaf-off by hand until the phenology check exists.</div>

			{/* Phenology bar */}
			{isPhenologyLoading ? (
				<InlineSkeleton label="Loading phenology data" className="mb-2 h-6 w-full" />
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

			<NoteField name="phenology_notes" placeholder="Seasonal observations..." label="Add a phenology note" />
		</div>
	);
}

// === Prediction quality: the saved rating of one layer ===
const RATING = {
	deadwood: { field: "deadwood_quality", notes: "deadwood_notes", title: "Deadwood cover segmentation", note: "deadwood", required: true },
	forest_cover: { field: "forest_cover_quality", notes: "forest_cover_notes", title: "Tree cover segmentation", note: "tree cover", required: false },
} as const;

/** One prediction layer's saved rating and note. `byCheck`: the audit check ran on the layer; its
 * answer row above decides the rating, so the radio is hidden. */
export function PredictionQualityCard({
	layer,
	suggestions,
	prefilledFields,
	byCheck,
}: {
	layer: "deadwood" | "forest_cover";
	suggestions: IAuditSuggestion[];
	prefilledFields: string[];
	byCheck?: boolean;
}) {
	const { field, notes, title, note, required } = RATING[layer];
	return (
		<div>
			<div className={byCheck ? "hidden" : "mb-1 flex items-center"}>
				<Text className="text-xs font-medium">{title}</Text>
				<SuggestedTag field={field} suggestions={suggestions} prefilledFields={prefilledFields} />
			</div>
			<Form.Item
				name={field}
				className="mb-1"
				hidden={byCheck}
				rules={required ? createConditionalRule("Please rate deadwood quality") : [{ required: false, message: `Please rate ${note} quality` }]}
			>
				<Radio.Group>
					<Space size="large">
						<Radio value="great">🟢 Great</Radio>
						<Radio value="sentinel_ok">🟡 OK</Radio>
						<Radio value="bad">🔴 Bad</Radio>
					</Space>
				</Radio.Group>
			</Form.Item>
			<NoteField name={notes} placeholder={`${note.charAt(0).toUpperCase()}${note.slice(1)} notes...`} label={`Add a ${note} note`} />
		</div>
	);
}

// === COG and thumbnail (dataset evaluation) ===
export function COGQualityCard() {
	return (
		<div className="mb-3" data-testid="audit-cog">
			<Text className="text-xs font-medium">Cloud-Optimized GeoTIFF</Text>

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
		</div>
	);
}

interface ThumbnailCardProps {
	thumbnailUrl: string | null;
}

export function ThumbnailCard({ thumbnailUrl }: ThumbnailCardProps) {
	return (
		<div className="mb-3" data-testid="audit-thumbnail">
			<Text className="text-xs font-medium">Thumbnail</Text>

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
		</div>
	);
}

// === Ortho file: image facts, technical metadata and download (dataset evaluation) ===
interface OrthoFilePanelProps {
	dataset: IDataset;
	/** shown beside the facts; the legacy thumbnail card shows its own */
	thumbnailUrl?: string | null;
	orthoMetadata: OrthoMetadata | null | undefined;
	isOrthoLoading: boolean;
	isDownloading: boolean;
	currentDownloadId: string | null;
	onStartDownload: (dataset: IDataset) => void;
}

export function OrthoFilePanel({
	dataset,
	thumbnailUrl,
	orthoMetadata,
	isOrthoLoading,
	isDownloading,
	currentDownloadId,
	onStartDownload,
}: OrthoFilePanelProps) {
	const isViewOnlyDataset = dataset.data_access === "viewonly";
	const facts = imageFacts(orthoMetadata?.ortho_info);

	// one line to read at a glance; the table, the raw metadata and the download behind "File details"
	const glance = facts.filter((f) => ["Size", "Resolution", "Bands", "File"].includes(f.label)).map((f) => f.value);
	const warnings = facts.filter((f) => f.tone === "warn");

	return (
		<div className="flex flex-col gap-1">
			{isOrthoLoading ? (
				<InlineSkeleton label="Loading technical metadata" className="h-8 w-full" />
			) : (
				<div className="flex items-center gap-2 text-xs" data-testid="audit-image-facts">
					{thumbnailUrl && (
						<Image src={thumbnailUrl} alt="Dataset thumbnail" width={40} height={40} style={{ objectFit: "cover" }} className="rounded border" />
					)}
					<div className="min-w-0 flex-1">
						<div className="text-gray-700">{glance.length ? glance.join(" · ") : "No technical metadata available"}</div>
						{warnings.map((w, i) => (
							<div key={i} className="font-medium text-amber-800">
								{w.label}: {w.value}
							</div>
						))}
					</div>
				</div>
			)}
			<Collapse size="small" ghost className="-mx-3">
				<Panel header={<span className="text-xs text-gray-500">File details</span>} key="details">
					<div className="flex flex-col gap-2">
						{facts.length > 0 && (
							<dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
								{facts.map((fact, i) => (
									<Fragment key={i}>
										<dt className="text-gray-500">{fact.label}</dt>
										<dd className={`m-0 tabular-nums ${fact.tone === "warn" ? "font-medium text-amber-800" : fact.tone === "ok" ? "text-green-800" : ""}`}>
											{fact.value}
										</dd>
									</Fragment>
								))}
							</dl>
						)}
						{orthoMetadata?.ortho_info && (
							<Collapse size="small" ghost>
								<Panel header={<span className="text-xs">All technical metadata</span>} key="1">
									<div className="max-h-64 overflow-y-auto">
										<pre className="whitespace-pre-wrap rounded bg-gray-50 p-2 text-xs">{JSON.stringify(orthoMetadata.ortho_info, null, 2)}</pre>
									</div>
								</Panel>
							</Collapse>
						)}
						<div>
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
					</div>
				</Panel>
			</Collapse>
		</div>
	);
}
