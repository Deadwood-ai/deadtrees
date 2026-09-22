import { useMemo } from "react";
import { App as AntdApp, Alert, Button, Input, Modal, Skeleton, Typography } from "antd";
import { CopyOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { fetchFactoryRowsByIds } from "../../hooks/useFactory";
import { buildSnapshotText } from "./factoryFormat";
import { useCopyToClipboard } from "./FactorySelectionContext";
import { FactoryError } from "./FactoryPrimitives";
import type { FactoryFilters } from "./factoryTypes";

const { Text } = Typography;

type FactorySnapshotModalProps = {
	open: boolean;
	ids: number[];
	filters?: FactoryFilters;
	onClose: () => void;
};

/**
 * Shows the exact text an operator is about to copy. The text is fetched fresh
 * so its "as of" time is honest, and it never contains request wording.
 */
export default function FactorySnapshotModal({ open, ids, filters, onClose }: FactorySnapshotModalProps) {
	const { message } = AntdApp.useApp();
	const copy = useCopyToClipboard();
	const idsKey = ids.join(",");

	const snapshot = useQuery({
		queryKey: ["factory", "snapshot", idsKey],
		enabled: open && ids.length > 0,
		queryFn: () => fetchFactoryRowsByIds(ids),
		staleTime: 0,
		retry: false,
	});

	const text = useMemo(() => {
		if (!snapshot.data) return "";
		const returned = new Set(snapshot.data.rows.map((row) => row.dataset_id));
		return buildSnapshotText({
			rows: snapshot.data.rows,
			asOf: snapshot.data.as_of,
			asOfFirst: snapshot.data.as_of_first,
			reads: snapshot.data.reads,
			origin: window.location.origin,
			filters,
			missingIds: ids.filter((id) => !returned.has(id)),
		});
	}, [snapshot.data, filters, ids]);

	const handleCopy = async () => {
		const ok = await copy(text);
		if (ok) {
			message.success(`Copied facts for ${ids.length} dataset${ids.length === 1 ? "" : "s"}`);
		} else {
			message.warning("Clipboard is unavailable here. Select the text and copy it manually.");
		}
	};

	return (
		<Modal
			open={open}
			onCancel={onClose}
			title={`Snapshot for ${ids.length} dataset${ids.length === 1 ? "" : "s"}`}
			width={860}
			footer={[
				<Button key="close" onClick={onClose}>
					Close
				</Button>,
				<Button
					key="copy"
					type="primary"
					icon={<CopyOutlined />}
					disabled={!text || snapshot.isLoading}
					onClick={() => void handleCopy()}
				>
					Copy to clipboard
				</Button>,
			]}
		>
			<Alert
				type="info"
				showIcon
				className="mb-3"
				message="Facts only"
				description="The text records what the database shows right now, including gaps. It contains no request, so pasting it into a task implies no action."
			/>
			{snapshot.isLoading && <Skeleton active paragraph={{ rows: 6 }} />}
			{snapshot.isError && <FactoryError error={snapshot.error} onRetry={() => void snapshot.refetch()} />}
			{snapshot.data && (
				<>
					<Input.TextArea
						readOnly
						value={text}
						autoSize={{ minRows: 8, maxRows: 22 }}
						className="font-mono text-xs"
						data-testid="factory-snapshot-text"
						onFocus={(event) => event.target.select()}
					/>
					<Text type="secondary" className="mt-2 block text-xs">
						Links point to this workspace. Contributor emails are included because operators need them; treat the text as internal.
					</Text>
				</>
			)}
		</Modal>
	);
}
