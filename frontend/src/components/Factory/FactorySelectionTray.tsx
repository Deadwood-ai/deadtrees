import { useState } from "react";
import { App as AntdApp, Button, Space } from "antd";
import { CopyOutlined, FileTextOutlined } from "@ant-design/icons";
import { formatIdList } from "./factorySelection";
import { useCopyToClipboard, useFactorySelection } from "./FactorySelectionContext";
import FactorySnapshotModal from "./FactorySnapshotModal";

/** Floating summary of the cross-page selection with the two copy actions. */
export default function FactorySelectionTray() {
	const { selectedIds, clear } = useFactorySelection();
	const { message } = AntdApp.useApp();
	const copy = useCopyToClipboard();
	const [snapshotOpen, setSnapshotOpen] = useState(false);

	if (selectedIds.length === 0) return null;

	const handleCopyIds = async () => {
		const ok = await copy(formatIdList(selectedIds));
		if (ok) {
			message.success(`Copied ${selectedIds.length} dataset ID${selectedIds.length === 1 ? "" : "s"}`);
		} else {
			message.warning("Clipboard is unavailable here. Use “Copy context” to see the text instead.");
		}
	};

	return (
		<>
			<div
				className="fixed bottom-4 left-1/2 z-40 flex w-[calc(100%-2rem)] max-w-3xl -translate-x-1/2 flex-wrap items-center justify-between gap-3 rounded-2xl border border-gray-200/80 bg-white/95 px-4 py-3 shadow-lg backdrop-blur"
				data-testid="factory-selection-tray"
				role="region"
				aria-label="Selected datasets"
			>
				<div className="text-sm text-gray-700">
					<span className="font-semibold text-gray-900">{selectedIds.length}</span> selected
					<span className="ml-2 hidden text-gray-400 sm:inline">{formatIdList(selectedIds.slice(0, 6))}{selectedIds.length > 6 ? ", …" : ""}</span>
				</div>
				<Space wrap>
					<Button icon={<CopyOutlined />} onClick={() => void handleCopyIds()}>
						Copy IDs
					</Button>
					<Button type="primary" icon={<FileTextOutlined />} onClick={() => setSnapshotOpen(true)}>
						Copy context
					</Button>
					<Button type="text" onClick={clear}>
						Clear
					</Button>
				</Space>
			</div>
			<FactorySnapshotModal open={snapshotOpen} ids={selectedIds} onClose={() => setSnapshotOpen(false)} />
		</>
	);
}
