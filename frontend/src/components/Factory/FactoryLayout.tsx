import { Suspense } from "react";
import { Segmented, Spin, Typography } from "antd";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { RequireAuth } from "../AuthGate";
import { useCanOperate } from "../../hooks/useUserPrivileges";
import { FactorySelectionProvider } from "./FactorySelectionContext";
import FactorySelectionTray from "./FactorySelectionTray";
import { FactoryDenied, ReadOnlyBadge } from "./FactoryPrimitives";

const { Title, Text } = Typography;

type FactorySection = "overview" | "operations" | "datasets" | "activity";

const SECTION_PATHS: Record<FactorySection, string> = {
	overview: "/factory",
	operations: "/factory/operations",
	datasets: "/factory/datasets",
	activity: "/factory/activity",
};

function sectionFromPath(pathname: string): FactorySection {
	if (pathname.startsWith("/factory/operations")) return "operations";
	if (pathname.startsWith("/factory/datasets")) return "datasets";
	if (pathname.startsWith("/factory/activity")) return "activity";
	return "overview";
}

function FactoryShell() {
	const { canOperate, isLoading } = useCanOperate();
	const location = useLocation();
	const navigate = useNavigate();

	if (isLoading) {
		return (
			<div className="flex min-h-[60vh] items-center justify-center">
				<Spin size="large" />
			</div>
		);
	}

	if (!canOperate) {
		return <FactoryDenied />;
	}

	const section = sectionFromPath(location.pathname);

	return (
		<FactorySelectionProvider>
			<div className="w-full bg-[#F8FAF9] min-h-[calc(100vh-64px)] pb-32 pt-24 md:pt-28" data-testid="factory-page">
				<div className="mx-auto max-w-[1920px] px-4 md:px-8 xl:px-12">
					<header className="mb-6 flex flex-wrap items-start justify-between gap-4">
						<div>
							<div className="flex items-center gap-3">
								<Title level={2} style={{ margin: 0, fontWeight: 700 }}>
									Factory
								</Title>
								<ReadOnlyBadge />
							</div>
							<Text type="secondary" className="mt-1 block max-w-2xl">
								Whether DeadTrees turns contributions into trusted, reused data, and where work waits. Nothing on
								these pages triggers an action; copy the facts and hand them on.
							</Text>
						</div>
						<Segmented<FactorySection>
							size="large"
							className="shadow-sm border border-gray-200/50"
							value={section}
							onChange={(value) => navigate(SECTION_PATHS[value])}
							options={[
								{ label: "Overview", value: "overview" },
								{ label: "Operations", value: "operations" },
								{ label: "Datasets", value: "datasets" },
								{ label: "Activity", value: "activity" },
							]}
						/>
					</header>
					<Suspense
						fallback={
							<div className="flex min-h-60 items-center justify-center">
								<Spin size="large" />
							</div>
						}
					>
						<Outlet />
					</Suspense>
				</div>
			</div>
			<FactorySelectionTray />
		</FactorySelectionProvider>
	);
}

/** Route element for `/factory/*`: authentication first, then the operator gate, then the workspace shell. */
export default function FactoryLayout() {
	return (
		<RequireAuth>
			<FactoryShell />
		</RequireAuth>
	);
}
