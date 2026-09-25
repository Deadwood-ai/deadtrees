import { Alert, Button } from "antd";

interface AuditLockBlockedProps {
	message: string;
	children: React.ReactNode;
}

/** Full-page state while this page cannot hold the dataset's audit lease. */
export function AuditLockBlocked({ message, children }: AuditLockBlockedProps) {
	return (
		<div className="flex h-full w-full items-center justify-center">
			<div className="max-w-md text-center">
				<div className="mb-2 font-medium">{message}</div>
				{children}
			</div>
		</div>
	);
}

interface AuditOpenElsewhereProps {
	message: string;
	onBack: () => void;
	onContinueHere: () => void;
}

export function AuditOpenElsewhere({ message, onBack, onContinueHere }: AuditOpenElsewhereProps) {
	return (
		<AuditLockBlocked message={message}>
			<div className="mb-4 text-sm text-gray-500">Continuing here turns off saving on the other page.</div>
			<div className="flex justify-center gap-2">
				<Button onClick={onBack}>Back to queue</Button>
				<Button type="primary" onClick={onContinueHere}>
					Continue here
				</Button>
			</div>
		</AuditLockBlocked>
	);
}

interface AuditLockLostNoticeProps {
	message: string;
	onBack: () => void;
}

/** Replaces the save actions once another page holds the lease. */
export function AuditLockLostNotice({ message, onBack }: AuditLockLostNoticeProps) {
	return (
		<Alert
			type="warning"
			showIcon
			message="Saving is turned off on this page"
			description={
				<>
					<div>{message}</div>
					{/* The surrounding audit form is disabled; leaving must stay possible. */}
					<Button size="small" className="mt-2" disabled={false} onClick={onBack}>
						Back to queue
					</Button>
				</>
			}
		/>
	);
}
