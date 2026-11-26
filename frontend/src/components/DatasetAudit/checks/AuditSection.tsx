import type { ReactNode } from "react";
import { DownOutlined, RightOutlined } from "@ant-design/icons";
import type { AuditTone } from "../../../utils/auditChecks";

const TONE_CLASSES: Record<AuditTone, { badge: string }> = {
	ok: { badge: "bg-green-50 text-green-800" },
	warn: { badge: "bg-amber-50 text-amber-800" },
	bad: { badge: "bg-red-50 text-red-800" },
	todo: { badge: "bg-gray-100 text-gray-700" },
};

interface AuditSectionProps {
	number: number;
	title: string;
	status: { label: string; tone: AuditTone };
	open: boolean;
	onToggle: () => void;
	children: ReactNode;
}

/** One step in the Audit Review sidebar: a header with its status, opened one at a time (Enter
 * goes on to the next step, Shift+Enter back).
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
