import { useState } from "react";
import { Button, Form, Input } from "antd";

/** A saved-audit note that stays out of the way: an "Add note" link until it is opened or holds
 * text. The field stays registered either way, so a prefilled note is saved. */
export default function NoteField({
	name,
	placeholder,
	label = "Add note",
	required = false,
}: {
	name: string;
	placeholder: string;
	label?: string;
	/** the note is needed now: always shown */
	required?: boolean;
}) {
	const form = Form.useFormInstance();
	const value = Form.useWatch(name, { form, preserve: true });
	const [open, setOpen] = useState(false);
	const shown = required || open || (typeof value === "string" && value.trim() !== "");
	return (
		<>
			{!shown && (
				<Button type="link" size="small" className="!h-auto !p-0 text-xs" onClick={() => setOpen(true)}>
					{label}
				</Button>
			)}
			<Form.Item name={name} className="mb-0" hidden={!shown}>
				<Input.TextArea rows={1} autoSize={{ minRows: 1, maxRows: 4 }} placeholder={placeholder} className="text-xs" />
			</Form.Item>
		</>
	);
}
