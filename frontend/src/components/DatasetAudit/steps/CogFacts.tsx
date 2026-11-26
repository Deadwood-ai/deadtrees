import { Fragment } from "react";
import { Button, Collapse, Tooltip } from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import type { IDataset } from "../../../types/dataset";
import type { CogMetadata } from "../../../hooks/useDatasetAudit";
import { imageFacts } from "../../../utils/imageFacts";
import { InlineSkeleton } from "../../SectionStates";

export interface CogFactsProps {
	dataset: IDataset;
	cog: CogMetadata | null | undefined;
	isLoading: boolean;
	isDownloading: boolean;
	currentDownloadId: string | null;
	onStartDownload: (dataset: IDataset) => void;
}

/** The map image (COG) at a glance: size, resolution, bands and whether it is a valid COG, read
 * from v2_cogs.cog_info; the full table, the raw metadata and the download behind "File details". */
export default function CogFacts({ dataset, cog, isLoading, isDownloading, currentDownloadId, onStartDownload }: CogFactsProps) {
	const facts = imageFacts(cog?.cog_info);
	const glance = facts.filter((f) => ["Size", "Resolution", "Bands", "File"].includes(f.label)).map((f) => f.value);
	const warnings = facts.filter((f) => f.tone === "warn");
	const viewOnly = dataset.data_access === "viewonly";

	return (
		<div className="flex flex-col gap-1">
			{isLoading ? (
				<InlineSkeleton label="Loading the map image metadata" className="h-8 w-full" />
			) : (
				<div className="text-xs" data-testid="audit-image-facts">
					<div className="text-gray-700">{glance.length ? glance.join(" · ") : "No map image metadata yet"}</div>
					{warnings.map((w, i) => (
						<div key={i} className="font-medium text-amber-800">
							{w.label}: {w.value}
						</div>
					))}
				</div>
			)}
			<Collapse
				size="small"
				ghost
				className="-mx-3"
				items={[
					{
						key: "details",
						label: <span className="text-xs text-gray-500">File details</span>,
						children: (
							<div className="flex flex-col gap-2">
								{facts.length > 0 && (
									<dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
										{facts.map((fact, i) => (
											<Fragment key={i}>
												<dt className="text-gray-500">{fact.label}</dt>
												<dd className={`m-0 tabular-nums ${fact.tone === "warn" ? "font-medium text-amber-800" : fact.tone === "ok" ? "text-green-800" : ""}`}>
													{fact.value}
												</dd>
											</Fragment>
										))}
									</dl>
								)}
								{cog?.cog_info && (
									<Collapse
										size="small"
										ghost
										items={[
											{
												key: "raw",
												label: <span className="text-xs">All technical metadata</span>,
												children: (
													<pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded bg-gray-50 p-2 text-xs">{JSON.stringify(cog.cog_info, null, 2)}</pre>
												),
											},
										]}
									/>
								)}
								<div>
									<Tooltip title={viewOnly ? "View-only dataset: orthophoto download is restricted" : "Download the orthophoto for local testing"}>
										<Button
											size="small"
											icon={<DownloadOutlined />}
											disabled={isDownloading || viewOnly}
											loading={isDownloading && currentDownloadId === `${dataset.id}-ortho`}
											onClick={() => onStartDownload(dataset)}
										>
											Download Orthophoto
										</Button>
									</Tooltip>
								</div>
							</div>
						),
					},
				]}
			/>
		</div>
	);
}
