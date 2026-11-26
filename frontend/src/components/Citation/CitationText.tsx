import { Button, Input, Tooltip, message } from "antd";
import { CopyOutlined } from "@ant-design/icons";

const copy = async (text: string) => {
	try {
		await navigator.clipboard.writeText(text);
		message.success("Copied to clipboard");
	} catch {
		message.error("Copy failed");
	}
};

interface CitationTextProps {
	label: "BibTeX" | "APA";
	text: string;
	/** smaller type for a sidebar */
	compact?: boolean;
}

/** One citation format with its label and a copy button, as the About page shows them. */
export default function CitationText({ label, text, compact }: CitationTextProps) {
	return (
		<div>
			<div className={`${compact ? "mb-1" : "mb-3"} flex items-center justify-between`}>
				<span className={`${compact ? "text-[11px]" : "text-sm"} font-bold uppercase tracking-wider text-gray-500`}>{label}</span>
				<Tooltip title={`Copy ${label}`}>
					<Button size="small" icon={<CopyOutlined />} onClick={() => void copy(text)}>
						Copy
					</Button>
				</Tooltip>
			</div>
			<Input.TextArea
				readOnly
				value={text}
				autoSize={label === "BibTeX" ? { minRows: compact ? 3 : 4, maxRows: compact ? 8 : 12 } : { minRows: 2, maxRows: 8 }}
				className={`custom-scrollbar rounded-lg bg-slate-50 font-mono text-slate-700 ${compact ? "p-2 text-[11px]" : `p-4 ${label === "BibTeX" ? "text-xs" : "text-sm"}`}`}
			/>
		</div>
	);
}
