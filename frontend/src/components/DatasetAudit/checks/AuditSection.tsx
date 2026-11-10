import type { ReactNode } from "react";
import { DownOutlined, RightOutlined } from "@ant-design/icons";
import type { AuditTone } from "../../../utils/auditChecks";

export const TONE_CLASSES: Record<AuditTone, { dot: string; badge: string }> = {
	ok: { dot: "bg-green-600", badge: "bg-green-50 text-green-800" },
	warn: { dot: "bg-amber-500", badge: "bg-amber-50 text-amber-800" },
	bad: { dot: "bg-red-600", badge: "bg-red-50 text-red-800" },
	todo: { dot: "bg-gray-400", badge: "bg-gray-100 text-gray-700" },
};

interface AuditSectionProps {
	number: number;
	title: string;
	status: { label: string; tone: AuditTone };
	open: boolean;
	onToggle: () => void;
	children: ReactNode;
}

/** One check in the audit sidebar: a header with its status, opened one at a time.
 * Closed sections stay mounted so their form fields keep validating and saving. */
export default function AuditSection({ number, title, status, open, onToggle, children }: AuditSectionProps) {
	const tone = TONE_CLASSES[status.tone];
	return (
		<section className={`mb-1 rounded-lg ${open ? "bg-slate-50" : ""}`}>
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={open}
				className="flex min-h-[44px] w-full cursor-pointer items-center gap-2 rounded-lg border-0 bg-transparent px-2 text-left hover:bg-slate-100"
			>
				<span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-full ${tone.dot}`} />
				<span className="flex-1 text-sm font-semibold text-gray-800">
					{number}. {title}
				</span>
				<span className={`rounded-full px-2 py-0.5 text-[11px] ${tone.badge}`}>{status.label}</span>
				{open ? <DownOutlined className="text-[10px] text-gray-400" /> : <RightOutlined className="text-[10px] text-gray-400" />}
			</button>
			<div className={open ? "px-2 pb-3 pl-6" : "hidden"}>{children}</div>
		</section>
	);
}
