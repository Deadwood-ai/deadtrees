import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { Button } from "antd";
import { DatabaseOutlined, SearchOutlined, UploadOutlined } from "@ant-design/icons";
import ReactPlayer from "react-player";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../hooks/useAuthProvider";
import { useData } from "../../hooks/useDataProvider";
import { useDesktopOnlyFeature } from "../../hooks/useDesktopOnlyFeature";
import { isDatasetViewable } from "../../utils/datasetVisibility";
import { useAnalytics } from "../../hooks/useAnalytics";
import LogoBannerBand from "./LogoBanner";

const logos = [
	{ path: "assets/logos/esa.jpg" },
	{ path: "assets/logos/dfg.jpeg" },
	{ path: "assets/logos/uni-freiburg.png" },
	{ path: "assets/logos/leipzig.png", url: "https://www.uni-leipzig.de/" },
	{ path: "assets/logos/NFDI4Earth_logo.jpg" },
	{ path: "assets/logos/scads.png" },
	{ path: "assets/logos/MLR.png" },
	{ path: "assets/logos/dlr.jpeg" },
	{ path: "assets/logos/geonadir.png" },
	{ path: "assets/logos/bmwk.jpg", height: "h-14" },
];

const heroVideoConfig = {
	file: {
		attributes: {
			controlsList: "nodownload",
		},
	},
};

const AnimatedStat = ({ value, label }: { value: number | null; label: string }) => {
	const [displayValue, setDisplayValue] = useState<number | null>(null);
	const lastRenderedValueRef = useRef(0);
	const isInitializedRef = useRef(false);
	const duration = 1600;

	useEffect(() => {
		if (value === null) return;

		const startValue = isInitializedRef.current ? lastRenderedValueRef.current : 0;
		isInitializedRef.current = true;

		if (value === startValue) {
			lastRenderedValueRef.current = value;
			setDisplayValue(value);
			return;
		}

		const delta = value - startValue;
		let startTime: number | null = null;
		let animationFrame = 0;

		const animate = (timestamp: number) => {
			if (startTime === null) startTime = timestamp;
			const progress = Math.min((timestamp - startTime) / duration, 1);
			const easedProgress = 1 - Math.pow(1 - progress, 3);
			const nextValue = Math.round(startValue + delta * easedProgress);

			lastRenderedValueRef.current = nextValue;
			setDisplayValue(nextValue);

			if (progress < 1) {
				animationFrame = requestAnimationFrame(animate);
			} else {
				lastRenderedValueRef.current = value;
				setDisplayValue(value);
			}
		};

		animationFrame = requestAnimationFrame(animate);

		return () => cancelAnimationFrame(animationFrame);
	}, [value]);

	return (
		<div className="flex items-baseline gap-1.5">
			<span className="min-w-[3ch] text-xl font-bold tabular-nums text-[#FFB31C]">
				{displayValue === null ? "..." : displayValue.toLocaleString()}
			</span>
			<span className="text-sm font-medium text-gray-500">{label}</span>
		</div>
	);
};

const Hero = () => {
	const navigate = useNavigate();
	const { user } = useAuth();
	const { data, authors } = useData();
	const { isMobile, runDesktopOnlyAction } = useDesktopOnlyFeature();
	const { track } = useAnalytics("home");

	const stats = useMemo(() => {
		if (!data) return null;
		const valid = data.filter((item) => isDatasetViewable(item));
		const countries = new Set(valid.map((d) => d.admin_level_1).filter(Boolean));
		return {
			datasets: valid.length,
			countries: countries.size,
			contributors: authors?.length ?? 0,
		};
	}, [data, authors]);

	const handleContribute = useCallback(() => {
		track("landing_cta_clicked", {
			cta_name: "hero_contribute_drone_data",
			action_target: user ? "/profile" : "/sign-in",
			...(isMobile ? { blocked_reason: "mobile" } : {}),
		});
		runDesktopOnlyAction("upload", () => {
			if (user) {
				navigate("/profile");
			} else {
				navigate("/sign-in");
			}
		});
	}, [isMobile, navigate, runDesktopOnlyAction, track, user]);

	const handleExploreMap = useCallback(() => {
		track("landing_cta_clicked", {
			cta_name: "hero_explore_map",
			action_target: "/deadtrees",
		});
		navigate("/deadtrees");
	}, [navigate, track]);

	const handleExploreDatasets = useCallback(() => {
		track("landing_cta_clicked", {
			cta_name: "hero_explore_datasets",
			action_target: "/dataset",
		});
		navigate("/dataset");
	}, [navigate, track]);

	return (
		<section className="relative flex w-full flex-col overflow-hidden min-h-screen pt-24 md:pt-28">
			<div className="absolute inset-0 hidden bg-[radial-gradient(1000px_at_25%_35%,_var(--tw-gradient-stops))] from-emerald-100/60 via-green-50/30 to-white md:block"></div>

			<div className="relative z-10 m-auto flex w-full max-w-[1400px] flex-1 flex-col justify-center px-4 md:px-10">
				<div className="w-full flex flex-col gap-12 py-12 lg:flex-row lg:items-center lg:justify-between lg:gap-10 lg:py-0">
					{/* Left column */}
					<div className="flex flex-col items-center text-center lg:w-[42%] lg:items-start lg:text-left shrink-0">
						<div className="mb-6 inline-flex items-center gap-1.5 rounded-full border border-[#FFB31C]/40 bg-[#FFF4D9]/80 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.15em] text-[#AE5920]">
							<span className="text-sm">🚀</span>
							<span>Platform Live</span>
						</div>
						<h1 className="m-0 bg-gradient-to-br from-green-950 via-green-800 to-emerald-700 bg-clip-text pb-6 text-4xl font-bold leading-tight text-transparent md:text-5xl lg:text-6xl xl:text-[4rem]">
							Mapping global tree mortality
						</h1>
						<p className="m-0 max-w-lg text-lg leading-relaxed text-gray-500">
							Contribute drone imagery of forests to help monitor tree mortality and forest health using AI. All forest data is valuable and powers the next generation of global satellite models.
						</p>

						<div className="mt-10 flex flex-col gap-4 sm:flex-row">
							<Button
								type={isMobile ? "default" : "primary"}
								size="large"
								icon={<UploadOutlined />}
								onClick={handleContribute}
								className={`min-h-11 w-full px-6 sm:w-auto ${isMobile ? "hidden" : ""}`}
							>
								Contribute Drone Data
							</Button>
							{isMobile ? (
								<Button
									type="primary"
									size="large"
									icon={<SearchOutlined />}
									onClick={handleExploreMap}
									className="min-h-11 w-full px-6 sm:w-auto"
								>
									Explore Map
								</Button>
							) : (
								<Button
									type="default"
									size="large"
									onClick={handleExploreMap}
									icon={<SearchOutlined />}
									className="min-h-11 w-full px-6 sm:w-auto"
								>
									Explore Map
								</Button>
							)}
							{isMobile && (
								<Button
									size="large"
									icon={<DatabaseOutlined />}
									onClick={handleExploreDatasets}
									className="min-h-11 w-full px-6 sm:w-auto"
								>
									Explore Drone Data
								</Button>
							)}
						</div>

						{!isMobile && (
							<Button
								type="link"
								size="small"
								icon={<DatabaseOutlined />}
								onClick={handleExploreDatasets}
								className="mt-4 inline-flex h-auto self-center p-0 text-sm font-medium text-emerald-700 hover:text-emerald-800 lg:self-start"
							>
								Browse drone datasets in the archive
							</Button>
						)}

						<div className="mt-8 flex flex-wrap items-center justify-center gap-6 md:justify-start">
							<AnimatedStat value={stats?.datasets ?? null} label="Datasets" />
							<AnimatedStat value={stats?.countries ?? null} label="Countries" />
							<AnimatedStat value={stats?.contributors ?? null} label="Contributors" />
						</div>
					</div>

					{/* Right column — visual */}
					<div className="mt-8 flex w-full justify-center lg:mt-0 lg:w-[58%] lg:justify-end">
						<div className="relative aspect-video w-full max-w-[1120px] overflow-hidden rounded-2xl bg-gray-100 shadow-2xl ring-1 ring-black/5 transition-all duration-300 hover:-translate-y-2 hover:shadow-[0_30px_60px_-15px_rgba(0,0,0,0.3)]">
							<ReactPlayer
								url="https://data2.deadtrees.earth/assets/v1/New_Version_deadtrees_video.mp4"
								width="100%"
								height="100%"
								controls={true}
								playsinline
								loop={true}
								light="https://data2.deadtrees.earth/assets/v1/image.png"
								config={heroVideoConfig}
							/>
						</div>
					</div>
				</div>
			</div>

			{/* "Supported by" section */}
			<div className="relative z-10 mt-auto pt-16">
				<p className="m-0 pb-4 text-center text-xs font-semibold uppercase tracking-[0.15em] text-slate-400">
					Supported by
				</p>

				{/* Logo banner in white strip */}
				<div className="border-t border-slate-100 bg-white/90 shadow-[0_-4px_20px_-10px_rgba(0,0,0,0.05)] backdrop-blur-md">
					<div className="m-auto max-w-[1640px] px-4 md:px-10">
						<div className="py-4 md:py-6">
							<LogoBannerBand logos={logos} title="" compact />
						</div>
					</div>
				</div>
			</div>
		</section>
	);
};

export default Hero;
