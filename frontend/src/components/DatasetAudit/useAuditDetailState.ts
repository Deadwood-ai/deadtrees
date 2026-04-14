import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Form, message, notification } from "antd";
import confetti from "canvas-confetti";
import { IDataset } from "../../types/dataset";
import {
	useDatasetAudit,
	useSaveDatasetAudit,
	AuditFormValues,
	useSetAuditLock,
	useClearAuditLock,
	useOrthoMetadata,
	useMarkAsReviewed,
	useDatasetAOI,
} from "../../hooks/useDatasetAudit";
import { useAuth } from "../../hooks/useAuthProvider";
import { useDownload } from "../../hooks/useDownloadProvider";
import { useAuditNavigationGuard } from "../../hooks/useAuditNavigationGuard";
import { useAuditNavigation } from "../../hooks/useAuditNavigation";
import { useDatasetFlags, useUpdateFlagStatus } from "../../hooks/useDatasetFlags";
import { usePhenologyData } from "../../hooks/usePhenologyData";
import { useSeasonPrompt } from "../../hooks/useSeasonPrompt";
import { supabase } from "../../hooks/useSupabase";
import { AOIToolbarState } from "../DatasetDetailsMap/DatasetDetailsMap";

export interface UseAuditDetailStateProps {
	dataset: IDataset;
}

const GRATITUDE_MESSAGES = [
	"Thank you! That was careful work, and it shows. 🌲",
	"Grateful for your effort - this is the hard part. 🙌",
	"Thanks for the precision. It really adds up. 🎯",
	"Appreciate the care. One more dataset, way better. ✨",
	"Thank you for doing the unglamorous, important bit. 🧠",
	"Thanks - your sharp eyes just helped a lot. 👀",
	"Grateful for the patience. The data is cleaner now. 🧼",
	"Thanks! The forest data owes you a coffee. ☕",
	"Appreciate you. This work genuinely matters. 💚",
	"Thank you! That was brainwork, not busywork. 🧠",
	"Thanks for the focus - and the accuracy boost. 🎯",
	"Grateful for the hustle. Quality is up. 📈",
	"Thank you for the detail work. Seriously. 🔎",
	"Thanks! You just made the map kinder to truth. 🗺️",
	"Appreciate the craft. That was solid. 🪵",
	"Thank you. That was not easy, and you did it well. 💪",
	"Thanks - another dataset made less chaotic. 🧹",
	"Grateful for your time. The trees approve. 🌳",
	"Thank you! That is the kind of audit that counts. ✅",
	"Thanks for the care. The canopy salutes you. 🌿",
	"Appreciate the effort. Signal-to-noise just improved. 📡",
	"Thank you! Your work makes this trustworthy. 🔒",
	"Grateful for the grind - and the win. 🏆",
	"Thanks. You just leveled up data quality. 🎉",
];

const getRandomGratitudeMessage = () => {
	if (GRATITUDE_MESSAGES.length === 0) {
		return "Thank you. That was meaningful work. 🌲";
	}
	const idx = Math.floor(Math.random() * GRATITUDE_MESSAGES.length);
	return GRATITUDE_MESSAGES[idx];
};

const getLocalDayRangeIso = () => {
	const now = new Date();
	const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
	const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
	return { startIso: start.toISOString(), endIso: end.toISOString() };
};

const getDailyAuditCount = async (userId: string) => {
	const { startIso, endIso } = getLocalDayRangeIso();
	const { count, error } = await supabase
		.from("dataset_audit")
		.select("dataset_id", { count: "exact", head: true })
		.eq("audited_by", userId)
		.gte("audit_date", startIso)
		.lte("audit_date", endIso);
	if (error) throw error;
	return count ?? 0;
};

const fireConfetti = (count: number) => {
	const safeCount = Math.max(1, count);
	const intensity = Math.min(safeCount, 25);
	const particleCount = 25 + intensity * 4;
	const spread = 55 + intensity * 1.6;
	const startVelocity = 22 + intensity * 0.6;
	const ticks = 140 + intensity * 6;
	const scalar = 0.85 + intensity * 0.01;
	try {
		confetti({
			particleCount,
			spread,
			startVelocity,
			gravity: 0.9,
			decay: 0.9,
			scalar,
			ticks,
			origin: { y: 0.7 },
		});
	} catch (error) {
		console.debug("Confetti skipped", error);
	}
};

export function useAuditDetailState({ dataset }: UseAuditDetailStateProps) {
	const navigate = useNavigate();
	const [form] = Form.useForm<AuditFormValues>();
	const { user } = useAuth();

	// Download state
	const { isDownloading, startDownload, finishDownload, currentDownloadId } = useDownload();

	// AOI state
	const currentAOIGeometry = useRef<GeoJSON.MultiPolygon | GeoJSON.Polygon | null>(null);
	const [hasAOI, setHasAOI] = useState(false);
	const [isAOILoaded, setIsAOILoaded] = useState(false);

	// AOI toolbar state (reported from map component)
	const [aoiToolbarState, setAoiToolbarState] = useState<AOIToolbarState>({
		isDrawing: false,
		isEditing: false,
		hasAOI: false,
		isAOILoading: true,
		selectedFeatureForEdit: false,
		polygonCount: 0,
	});

	// Data hooks
	const { data: auditData, isLoading: isAuditLoading } = useDatasetAudit(dataset.id);
	const { data: flags = [], isLoading: isFlagsLoading } = useDatasetFlags(dataset.id);
	const { mutateAsync: updateFlagStatus, isPending: isUpdatingFlag } = useUpdateFlagStatus();
	const { mutateAsync: saveAudit, isPending: isSavingAudit } = useSaveDatasetAudit();
	const { mutateAsync: markAsReviewed, isPending: isMarkingReviewed } = useMarkAsReviewed();
	const { data: orthoMetadata, isLoading: isOrthoLoading } = useOrthoMetadata(dataset.id);
	const { data: phenologyData, isLoading: isPhenologyLoading } = usePhenologyData(dataset.id);
	const { data: aoiData, isLoading: isAOIDataLoading } = useDatasetAOI(dataset.id);

	// Navigation context
	const { getNextDatasetId, currentIndex, totalCount } = useAuditNavigation();

	// Audit lock mutations
	const { mutateAsync: setAuditLock } = useSetAuditLock();
	const { mutateAsync: clearAuditLock } = useClearAuditLock();

	// Season prompt
	const { copyPromptWithImage } = useSeasonPrompt();

	// Local state
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [auditLockError, setAuditLockError] = useState<string | null>(null);
	const [isLockingAudit, setIsLockingAudit] = useState(true);
	const [hasFormChanges, setHasFormChanges] = useState(false);
	const [navigateToNext, setNavigateToNext] = useState(false);

	// Navigation guard
	const { showExitConfirmation } = useAuditNavigationGuard({
		isActive: !auditLockError && !isSubmitting,
		onCleanup: async () => {
			if (!auditLockError) {
				await clearAuditLock(dataset.id);
			}
		},
		datasetId: dataset.id,
		hasFormChanges,
	});

	// Reset state and set audit lock when dataset changes
	useEffect(() => {
		setIsLockingAudit(true);
		setAuditLockError(null);
		setHasFormChanges(false);
		setHasAOI(false);
		setIsAOILoaded(false);
		currentAOIGeometry.current = null;
		form.resetFields();

		const lockAudit = async () => {
			try {
				await setAuditLock(dataset.id);
				setAuditLockError(null);
				setIsLockingAudit(false);
				setHasFormChanges(true);
			} catch (error) {
				console.error("Failed to set audit lock:", error);
				const errorMessage = error instanceof Error ? error.message : "Could not lock dataset for audit";
				setAuditLockError(errorMessage);
				setIsLockingAudit(false);
				message.error(errorMessage);
				setTimeout(() => navigate("/dataset-audit"), 2000);
			}
		};

		lockAudit();
	}, [dataset.id, setAuditLock, navigate, form]);

	// Set form values when audit data is loaded
	useEffect(() => {
		if (auditData) {
			const partial: Partial<AuditFormValues> = { ...auditData } as unknown as Partial<AuditFormValues>;
			const toDelete: (keyof Partial<AuditFormValues>)[] = ["audit_date"];
			toDelete.forEach((k) => delete (partial as Record<string, unknown>)[k as string]);
			form.setFieldsValue(partial);
		}
	}, [auditData, form]);

	// Track form changes
	useEffect(() => {
		const handleFormChange = () => setHasFormChanges(true);
		const formElement = document.querySelector(".ant-form");
		if (!formElement) return;
		formElement.addEventListener("change", handleFormChange);
		formElement.addEventListener("input", handleFormChange);
		return () => {
			formElement.removeEventListener("change", handleFormChange);
			formElement.removeEventListener("input", handleFormChange);
		};
	}, []);

	// AOI change handler
	const handleAOIChange = useCallback((geometry: GeoJSON.MultiPolygon | GeoJSON.Polygon | null) => {
		console.debug("AOI changed:", geometry ? "AOI present" : "AOI cleared");
		currentAOIGeometry.current = geometry;
		setHasAOI(!!geometry);
		setIsAOILoaded(true);
	}, []);

	// Mark AOI as loaded once the AOI query completes (even if empty)
	useEffect(() => {
		if (isAOIDataLoading || isAOILoaded) return;

		if (aoiData?.geometry) {
			currentAOIGeometry.current = aoiData.geometry as GeoJSON.MultiPolygon | GeoJSON.Polygon;
			setHasAOI(true);
		} else {
			currentAOIGeometry.current = null;
			setHasAOI(false);
		}

		setIsAOILoaded(true);
	}, [isAOIDataLoading, isAOILoaded, aoiData]);

	// Form submit handler
	const handleSubmit = async (values: AuditFormValues) => {
		if (!isAOILoaded) {
			message.warning("AOI is still loading, please wait...");
			return;
		}

		if (flags.some((f) => f.status === "open")) {
			message.error("There are open user-reported issues. Please acknowledge them before saving.");
			return;
		}

		if (values.final_assessment === "fixable_issues" && !values.notes?.trim()) {
			message.error("Please provide detailed notes for the fixable issues");
			return;
		}

		if (values.final_assessment === "exclude_completely" && !values.notes?.trim()) {
			message.error("Please provide detailed notes for excluding this dataset");
			return;
		}

		if (values.final_assessment === "no_issues" && !currentAOIGeometry.current) {
			message.error("Please draw an AOI on the map before submitting");
			return;
		}

		try {
			setIsSubmitting(true);

			const auditPayload = {
				...values,
				dataset_id: dataset.id,
				aoi_done: !!currentAOIGeometry.current,
				aoiGeometry: currentAOIGeometry.current || undefined,
			};

			const isCompletion = !auditData;
			await saveAudit(auditPayload);
			if (!isCompletion) {
				message.success("Audit data updated successfully");
			}

			let dailyCountText = "";
			let dailyCountForConfetti = 1;
			if (user?.id) {
				try {
					const dailyCount = await getDailyAuditCount(user.id);
					dailyCountText = ` You have audited ${dailyCount} today. 🎉`;
					dailyCountForConfetti = dailyCount || 1;
				} catch (error) {
					console.debug("Failed to load daily audit count", error);
				}
			}

			fireConfetti(dailyCountForConfetti);
			notification.success({
				message: "Thank you 🌲✨",
				description: `${getRandomGratitudeMessage()}${dailyCountText}`,
				placement: "top",
				duration: 6,
			});

			setHasFormChanges(false);

			setTimeout(() => {
				if (navigateToNext) {
					const nextId = getNextDatasetId(dataset.id);
					if (nextId) {
						navigate(`/dataset-audit/${nextId}`);
					} else {
						message.info("All datasets in filter completed");
						navigate("/dataset-audit");
					}
				} else {
					navigate("/dataset-audit");
				}
				setNavigateToNext(false);
			}, 100);
		} catch (error) {
			console.error("Error saving audit data:", error);
			message.error("Failed to save audit data");
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleSaveAndNext = () => {
		setNavigateToNext(true);
		form.submit();
	};

	const handleCancel = () => {
		showExitConfirmation(() => navigate("/dataset-audit"));
	};

	const handleMarkReviewedAndNext = async () => {
		try {
			await markAsReviewed(dataset.id);
			const nextId = getNextDatasetId(dataset.id);
			if (nextId) {
				navigate(`/dataset-audit/${nextId}`);
			} else {
				message.success("Review complete - returning to list");
				navigate("/dataset-audit");
			}
		} catch (error) {
			console.error("Error marking as reviewed:", error);
			message.error("Failed to mark as reviewed");
		}
	};

	// Computed values
	const isLoading = isAuditLoading || !user || isLockingAudit;
	const isSaving = isSavingAudit || isSubmitting;
	const isPending = !auditData;
	const isReviewed = auditData?.reviewed_at != null;
	const nextDatasetId = getNextDatasetId(dataset.id);
	const hasNextDataset = nextDatasetId !== null;
	const currentDatasetIndex = currentIndex(dataset.id);

	return {
		// Form
		form,
		handleSubmit,
		handleSaveAndNext,
		handleCancel,
		handleMarkReviewedAndNext,

		// State
		isLoading,
		isSaving,
		isPending,
		isReviewed,
		auditLockError,
		isLockingAudit,
		navigateToNext,

		// Data
		user,
		auditData,
		flags,
		isFlagsLoading,
		orthoMetadata,
		isOrthoLoading,
		phenologyData,
		isPhenologyLoading,

		// Flags
		updateFlagStatus,
		isUpdatingFlag,

		// Navigation
		nextDatasetId,
		hasNextDataset,
		currentDatasetIndex,
		totalCount,
		isMarkingReviewed,

		// AOI
		hasAOI,
		isAOILoaded,
		handleAOIChange,
		aoiToolbarState,
		setAoiToolbarState,

		// Download
		isDownloading,
		startDownload,
		finishDownload,
		currentDownloadId,

		// Season prompt
		copyPromptWithImage,
	};
}
