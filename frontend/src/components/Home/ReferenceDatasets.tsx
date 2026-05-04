import { Button, Tag } from "antd";
import { DatabaseOutlined, ArrowRightOutlined } from "@ant-design/icons";
import { Link } from "react-router-dom";

import {
	dteAerialReferenceDataset,
	getReferencePatchImages,
	type ReferenceDatasetSite,
} from "../../data/referenceDatasets";
import { GroundTruthMask } from "../ReferenceDatasets/GroundTruthMask";
import { useAnalytics } from "../../hooks/useAnalytics";

const FEATURED_PREVIEW_SITE_IDS = [375, 435, 1396, 4087, 5584, 6445];
const PREVIEW_MODES: Array<"rgb" | "mask"> = [
	"rgb",
	"mask",
	"rgb",
	"mask",
	"rgb",
	"mask",
];

const pickPreviewSites = (
	sites: ReferenceDatasetSite[],
	preferredIds: number[],
	count: number,
): ReferenceDatasetSite[] => {
	const byId = new Map(sites.map((site) => [site.id, site]));
	const preferred = preferredIds
		.map((id) => byId.get(id))
		.filter((site): site is ReferenceDatasetSite => Boolean(site));
	if (preferred.length >= count) return preferred.slice(0, count);
	const rest = sites.filter((site) => !preferredIds.includes(site.id));
	return [...preferred, ...rest].slice(0, count);
};

const ReferenceDatasetsSection = () => {
	const { track } = useAnalytics("home");
	const previewSites = pickPreviewSites(
		dteAerialReferenceDataset.sites,
		FEATURED_PREVIEW_SITE_IDS,
		6,
	);

	const trackCta = (cta: string, target: string) => () =>
		track("landing_cta_clicked", {
			cta_name: cta,
			action_target: target,
		});

	return (
		<section className="w-full bg-white py-24 md:py-32">
			<div className="m-auto max-w-6xl px-4 md:px-8">
				<div className="mb-12 text-center md:mb-16">
					<p className="mb-2 text-lg font-semibold uppercase tracking-wider text-[#1B5E35]">
						Reference Datasets
					</p>
					<h2 className="m-0 text-4xl font-semibold text-gray-800 md:text-5xl">
						Curated benchmarks for forest AI
					</h2>
					<p className="mx-auto mt-6 max-w-3xl text-lg text-gray-600">
						Stable, citable releases with expert reference masks, multi-resolution patches,
						and benchmark splits - built for reproducible machine learning research on
						tree cover and deadwood.
					</p>
				</div>

				<div className="mx-auto max-w-5xl">
					<Link
						to={`/reference-datasets/${dteAerialReferenceDataset.slug}`}
						onClick={trackCta(
							"home_reference_preview_strip",
							`/reference-datasets/${dteAerialReferenceDataset.slug}`,
						)}
						className="group block overflow-hidden rounded-2xl shadow-xl ring-1 ring-black/5 transition-all hover:shadow-2xl"
						aria-label="Open the DTE-aerial-bench reference gallery"
					>
						<div className="grid grid-cols-3 gap-px bg-gray-200 sm:grid-cols-6">
							{previewSites.map((site, index) => {
								const previewPatch = getReferencePatchImages(site, 20, 0);
								const mode = PREVIEW_MODES[index % PREVIEW_MODES.length];
								if (mode === "mask") {
									return (
										<GroundTruthMask
											key={site.id}
											forestCoverSrc={previewPatch.treeCoverMask}
											deadwoodSrc={previewPatch.mortalityMask}
											alt={`Reference mask from site ${site.id}`}
											size={256}
											className="transition-transform duration-300 group-hover:scale-[1.02]"
										/>
									);
								}
								return (
									<div
										key={site.id}
										className="aspect-square overflow-hidden bg-gray-100"
									>
										<img
											src={previewPatch.rgb}
											alt={`Benchmark patch from site ${site.id}`}
											loading="lazy"
											className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
										/>
									</div>
								);
							})}
						</div>
					</Link>

					<div className="mt-8 flex flex-col items-start justify-between gap-6 md:flex-row md:items-center">
						<div className="min-w-0">
							<div className="flex flex-wrap items-center gap-2">
								<Tag color="green" className="m-0">
									Available
								</Tag>
								<span className="text-sm font-semibold text-gray-700">
									{dteAerialReferenceDataset.shortName}
								</span>
								<span aria-hidden className="text-gray-300">
									-
								</span>
								<span className="text-sm text-gray-500">
									25 sites - 525 patches - 5, 10, 20 cm resolutions
								</span>
							</div>
							<p className="mt-2 text-base text-gray-600">
								A multi-resolution aerial benchmark for tree cover and mortality
								detection - alternating RGB patches with paired forest cover and
								deadwood reference masks.
							</p>
						</div>

						<div className="flex flex-shrink-0 flex-wrap items-center gap-3">
							<Link to="/reference-datasets">
								<Button
									type="primary"
									size="large"
									icon={<DatabaseOutlined />}
									className="min-h-11 px-6"
									onClick={trackCta(
										"home_browse_reference_data",
										"/reference-datasets",
									)}
								>
									Browse Reference Data
								</Button>
							</Link>
							<Link
								to={`/reference-datasets/${dteAerialReferenceDataset.slug}`}
								onClick={trackCta(
									"home_open_dte_aerial_bench_gallery",
									`/reference-datasets/${dteAerialReferenceDataset.slug}`,
								)}
								className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#1B5E35] hover:underline"
							>
								Open DTE-aerial-bench gallery
								<ArrowRightOutlined />
							</Link>
						</div>
					</div>
				</div>
			</div>
		</section>
	);
};

export default ReferenceDatasetsSection;
