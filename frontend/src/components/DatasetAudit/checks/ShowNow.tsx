import { Button } from "antd";

/** Reveals the models' and other reviewers' answers before you answer yourself. */
export default function ShowNow({ onClick }: { onClick: () => void }) {
	return (
		<Button type="link" size="small" className="h-auto p-0 text-[11px]" onClick={onClick}>
			Show now
		</Button>
	);
}
