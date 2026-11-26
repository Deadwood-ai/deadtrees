import type { ReactNode } from "react";

/** A labeled choice in a step; the labels share one width, so the choices line up. */
export default function ChoiceRow({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex items-center gap-3">
			<span className="w-28 shrink-0 text-xs text-gray-700">{label}</span>
			{children}
		</div>
	);
}

export const YES_NO = [
	{ label: "No", value: false },
	{ label: "Yes", value: true },
];
