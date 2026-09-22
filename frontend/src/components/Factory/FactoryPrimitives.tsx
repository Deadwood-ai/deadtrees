import { useEffect, useState, type ReactNode } from "react";
import { Button, Result, Tag, Tooltip, Typography } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { Link } from "react-router-dom";
import { isFactoryPermissionError } from "../../hooks/useFactory";
import {
	STATE_DESCRIPTIONS,
	formatRelative,
	formatUtc,
	stateLabel,
	stateTone,
	type FactoryTone,
} from "./factoryFormat";
import type { FactoryState } from "./factoryTypes";

const { Text } = Typography;

/** Re-renders relative timestamps without refetching. */
export function useNow(intervalMs = 30_000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
		return () => window.clearInterval(timer);
	}, [intervalMs]);
	return now;
}

const TONE_COLORS: Record<FactoryTone, string | undefined> = {
	processing: "processing",
	warning: "gold",
	error: "red",
	success: "green",
	muted: "default",
	default: undefined,
};

export function FactoryStateTag({ state }: { state: string | null | undefined }) {
	const description = state ? (STATE_DESCRIPTIONS as Record<string, string>)[state] : undefined;
	return (
		<Tooltip title={description}>
			<Tag color={TONE_COLORS[stateTone(state)]} className="m-0 whitespace-nowrap" data-testid="factory-state">
				{stateLabel(state as FactoryState | null)}
			</Tag>
		</Tooltip>
	);
}

export function Unknown({ reason }: { reason?: string }) {
	return (
		<Tooltip title={reason}>
			<span className="italic text-gray-400">unknown</span>
		</Tooltip>
	);
}

export function TimeCell({
	iso,
	now,
	emptyReason,
	emptyLabel,
}: {
	iso: string | null | undefined;
	now: number;
	emptyReason?: string;
	emptyLabel?: string;
}) {
	if (!iso) {
		return emptyLabel ? <span className="text-gray-400">{emptyLabel}</span> : <Unknown reason={emptyReason} />;
	}
	return (
		<Tooltip title={formatUtc(iso)}>
			<span className="whitespace-nowrap">{formatRelative(iso, now)}</span>
		</Tooltip>
	);
}

export function Freshness({
	asOf,
	isFetching,
	onRefresh,
	now,
}: {
	asOf: string | null | undefined;
	isFetching?: boolean;
	onRefresh?: () => void;
	now: number;
}) {
	return (
		<div className="flex flex-wrap items-center gap-2 text-sm text-gray-500" data-testid="factory-freshness">
			<span>
				Facts as of{" "}
				{asOf ? (
					<>
						<span className="font-medium text-gray-700">{formatUtc(asOf)}</span> ({formatRelative(asOf, now)})
					</>
				) : (
					<Unknown reason="The read model did not report a timestamp." />
				)}
			</span>
			{onRefresh && (
				<Button size="small" icon={<ReloadOutlined />} loading={isFetching} onClick={onRefresh}>
					Refresh
				</Button>
			)}
		</div>
	);
}

export function SectionCard({
	title,
	count,
	extra,
	children,
	testId,
}: {
	title: string;
	count?: number | null;
	extra?: ReactNode;
	children: ReactNode;
	testId?: string;
}) {
	return (
		<section className="rounded-2xl border border-gray-200/60 bg-white p-5 shadow-sm" data-testid={testId}>
			<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
				<h3 className="m-0 text-base font-semibold text-gray-900">
					{title}
					{typeof count === "number" && <span className="ml-2 text-sm font-normal text-gray-400">{count}</span>}
				</h3>
				{extra}
			</div>
			{children}
		</section>
	);
}

export function EmptyNote({ children }: { children: ReactNode }) {
	return <p className="m-0 rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-500">{children}</p>;
}

export function FactoryDenied() {
	return (
		<div className="flex min-h-[60vh] items-center justify-center">
			<Result
				status="403"
				title="Operator access required"
				subTitle="The Factory workspace is limited to DeadTrees operators. Ask the team if you need it."
				extra={
					<Link to="/">
						<Button type="primary">Back to home</Button>
					</Link>
				}
			/>
		</div>
	);
}

export function FactoryError({
	error,
	onRetry,
	title = "Could not load Factory data",
}: {
	error: unknown;
	onRetry?: () => void;
	title?: string;
}) {
	if (isFactoryPermissionError(error)) return <FactoryDenied />;
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
	return (
		<Result
			status="error"
			title={title}
			subTitle={message ? <Text type="secondary">{message}</Text> : "The request failed. Nothing has been changed."}
			extra={onRetry ? <Button onClick={onRetry}>Try again</Button> : undefined}
		/>
	);
}

export function ReadOnlyBadge() {
	return (
		<Tag color="default" className="m-0 rounded-full border-gray-200 bg-white px-3 text-gray-600">
			Read-only
		</Tag>
	);
}
