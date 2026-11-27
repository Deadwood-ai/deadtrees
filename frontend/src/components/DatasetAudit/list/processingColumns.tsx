import { Tag, Tooltip } from "antd";
import type { ColumnGroupType } from "antd/es/table";
import { CheckCircleFilled, CloseCircleFilled, MinusCircleOutlined, SyncOutlined } from "@ant-design/icons";
import { PROCESSING_STAGES, stageState, type IAuditListRow, type ProcessingStage, type StageState } from "../../../utils/auditReviewList";

const words = (value: string) => value.replace(/_/g, " ");

const ICONS: Record<StageState, JSX.Element> = {
	succeeded: <CheckCircleFilled className="text-green-600" />,
	failed: <CloseCircleFilled className="text-red-600" />,
	running: <SyncOutlined spin className="text-blue-600" />,
	not_run: <MinusCircleOutlined className="text-gray-300" />,
};

const STATE_TEXT: Record<StageState, string> = { succeeded: "succeeded", failed: "failed", running: "running", not_run: "not run" };

function StageCell({ row, stage }: { row: IAuditListRow; stage: ProcessingStage }) {
	const state = stageState(row, stage);
	const text = `${stage.label}: ${STATE_TEXT[state]}`;
	return (
		<Tooltip title={state === "failed" && row.error_message ? `${text}. ${row.error_message}` : text}>
			<span aria-label={text} data-testid={`stage-${stage.status}-${state}`}>
				{ICONS[state]}
			</span>
		</Tooltip>
	);
}

/** Where the dataset's processing is: failed (and where), running a stage, finished or waiting. */
function ProcessingStatus({ row }: { row: IAuditListRow }) {
	if (row.has_error) {
		const where = row.failed_stage && row.failed_stage !== "unknown" ? ` in ${words(row.failed_stage)}` : "";
		return (
			<Tooltip title={row.error_message ? `Failed${where}: ${row.error_message}` : `Failed${where}`}>
				<Tag color="red">Failed</Tag>
			</Tooltip>
		);
	}
	if (row.current_status && row.current_status !== "idle") return <Tag color="blue">{words(row.current_status)}</Tag>;
	return row.result?.is_processing_done ? <Tag color="green">Finished</Tag> : <Tag>Not finished</Tag>;
}

/** The processing stages, shown with the switch above the table: the status, then each stage. */
export function processingColumns(): ColumnGroupType<IAuditListRow> {
	return {
		title: "Processing stages",
		key: "processing",
		children: [
			{ title: "Status", key: "processing-status", width: 130, render: (_, row) => <ProcessingStatus row={row} /> },
			...PROCESSING_STAGES.map((stage) => ({
				title: <span className="text-xs">{stage.label}</span>,
				key: stage.done,
				width: 78,
				align: "center" as const,
				render: (_: unknown, row: IAuditListRow) => <StageCell row={row} stage={stage} />,
			})),
		],
	};
}
