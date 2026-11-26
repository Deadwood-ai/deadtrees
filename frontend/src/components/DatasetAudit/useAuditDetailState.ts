import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Form, message, notification } from "antd";
import confetti from "canvas-confetti";
import { IDataset } from "../../types/dataset";
import { useCogMetadata } from "../../hooks/useDatasetAudit";
import { useAuth } from "../../hooks/useAuthProvider";
import { useDownload } from "../../hooks/useDownloadProvider";
import { useAuditNavigationGuard } from "../../hooks/useAuditNavigationGuard";
import { describeAuditLockDenial, isAuditLeaseConflict, useAuditLock } from "../../hooks/useAuditLock";
import { useAuditNavigation } from "../../hooks/useAuditNavigation";
import { useAcquisitionDateEstimate, useGeorefCheck } from "../../hooks/useAcquisitionDateEstimate";
import { useAuditChecks, useAuditReviews, useSaveDatasetReviews } from "../../hooks/useAuditChecks";
import { useAuditDatasetResult } from "../../hooks/useAuditDatasetResults";
import { initialDraft, reviewAnswers, type IReviewDraft } from "../../utils/auditReview";
import { nextInList } from "../../utils/auditReviewList";
import { useAuditListRows } from "./list/useAuditListRows";
import { trackAppEvent } from "../../utils/analytics";
import { useAuditAOIState } from "./useAuditAOIState";

const GRATITUDE_MESSAGES = [
	"Thank you! That was careful work, and it shows. 🌲",
	"Grateful for your effort - this is the hard part. 🙌",
	"Thanks for the precision. It really adds up. 🎯",
	"Appreciate the care. One more dataset, way better. ✨",
	"Thanks - your sharp eyes just helped a lot. 👀",
	"Thanks! The forest data owes you a coffee. ☕",
	"Appreciate you. This work genuinely matters. 💚",
	"Thanks! You just made the map kinder to truth. 🗺️",
	"Thank you! Your work makes this trustworthy. 🔒",
	"Thanks for the care. The canopy salutes you. 🌿",
];

const thankYou = () => {
	try {
		confetti({ particleCount: 60, spread: 70, startVelocity: 26, gravity: 0.9, decay: 0.9, ticks: 160, origin: { y: 0.7 } });
	} catch (error) {
		console.debug("Confetti skipped", error);
	}
	notification.success({
		message: "Thank you 🌲✨",
		description: GRATITUDE_MESSAGES[Math.floor(Math.random() * GRATITUDE_MESSAGES.length)],
		placement: "top",
		duration: 5,
	});
};

/** Whether the reviewer changed the draft: a field whose value differs from where it started
 * (unset and null are the same). */
function draftChanged(start: IReviewDraft, now: IReviewDraft): boolean {
	const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
	const keys = new Set([...Object.keys(start), ...Object.keys(now)]) as Set<keyof IReviewDraft>;
	return [...keys].some((k) => !same(start[k], now[k]));
}

/** Everything the Audit Review detail page holds: the dataset's check results and outputs, the
 * reviewer's draft (an antd form of IReviewDraft), the review lease, the AOI editor and Save,
 * which stores only dataset reviews (utils/auditReview reviewAnswers). */
export function useAuditDetailState({ dataset }: { dataset: IDataset }) {
	const navigate = useNavigate();
	const [form] = Form.useForm<IReviewDraft>();
	const { user } = useAuth();
	const { isDownloading, startDownload, finishDownload, currentDownloadId } = useDownload();

	const aoi = useAuditAOIState(dataset.id);
	const { mutateAsync: saveReviews } = useSaveDatasetReviews();
	const { data: cogMetadata, isLoading: isCogLoading } = useCogMetadata(dataset.id);
	const { data: dateEstimate } = useAcquisitionDateEstimate(dataset.id);
	const { data: georefCheck } = useGeorefCheck(dataset.id);
	const auditChecksQuery = useAuditChecks(dataset.id);
	const auditChecks = auditChecksQuery.data;
	const auditReviewsQuery = useAuditReviews(dataset.id);
	const resultQuery = useAuditDatasetResult(dataset.id);
	const result = resultQuery.data;

	const { listPath } = useAuditNavigation();
	// Save & Next goes on to the next dataset of the list this was opened from, with its filters
	const { rows: listRows } = useAuditListRows();
	const nextDatasetId = useMemo(() => nextInList(listRows, listPath, dataset.id), [listRows, listPath, dataset.id]);
	const { state: auditLock, continueHere: continueAuditHere } = useAuditLock(dataset.id);

	const [isSubmitting, setIsSubmitting] = useState(false);
	const navigateToNext = useRef(false);
	// what the draft started from: leaving asks only when something differs from it
	const [startDraft, setStartDraft] = useState<IReviewDraft | null>(null);
	const draft = Form.useWatch([], { form, preserve: true }) as IReviewDraft | undefined;
	const hasFormChanges = aoi.isDirty || (!!startDraft && !!draft && draftChanged(startDraft, draft));

	// Another auditor holds the dataset (or the claim failed): return to the list.
	const auditLockError =
		auditLock.status === "denied" && !auditLock.heldByYou
			? describeAuditLockDenial(auditLock)
			: auditLock.status === "error"
				? auditLock.message
				: null;
	// The auditor's own other page holds it: let them choose where to continue.
	const auditOpenElsewhereMessage = auditLock.status === "denied" && auditLock.heldByYou ? describeAuditLockDenial(auditLock) : null;
	const auditLockLostMessage =
		auditLock.status !== "lost"
			? null
			: auditLock.heldByYou
				? "You continued this review in another tab or window. Saving here is turned off so that page's work is not overwritten."
				: `${auditLock.holderEmail ?? "Another auditor"} opened this dataset while this page was inactive. Saving here is turned off so their work is not overwritten.`;
	const isLockingAudit = auditLock.status === "claiming";
	const auditLeaseId = auditLock.status === "held" ? auditLock.leaseId : null;

	const { showExitConfirmation } = useAuditNavigationGuard({ isActive: !auditLockError && !isSubmitting, hasFormChanges });

	useEffect(() => {
		if (!auditLockError) return;
		message.error(auditLockError);
		const timeout = setTimeout(() => navigate(listPath), 2000);
		return () => clearTimeout(timeout);
	}, [auditLockError, navigate, listPath]);

	// The draft starts from the stored values once they load, once per dataset: later refetches
	// never touch what the reviewer is editing. Save starts it again from the new values.
	const startedFor = useRef<number | null>(null);
	useEffect(() => {
		if (resultQuery.isPending || startedFor.current === dataset.id) return;
		startedFor.current = dataset.id;
		form.resetFields();
		form.setFieldsValue(initialDraft(result));
		setStartDraft(initialDraft(result));
	}, [dataset.id, resultQuery.isPending, result, form]);

	// Every write carries this page's lease; without it nothing is saved.
	const requireAuditLease = () => {
		if (auditLock.status === "held") return auditLock.leaseId;
		message.error(auditLockLostMessage ?? "This page does not hold the review lock. Nothing was saved.");
		return null;
	};

	const handleSaveAOI = () => {
		const leaseId = requireAuditLease();
		if (leaseId) void aoi.handleSave(leaseId);
	};

	const leave = () => {
		const next = navigateToNext.current ? nextDatasetId : null;
		if (navigateToNext.current && !next) message.info("No other dataset needs review");
		navigate(next ? `/dataset-audit/${next}` : listPath);
	};

	const handleSubmit = async (values: IReviewDraft) => {
		const stop = (text: string) => {
			navigateToNext.current = false;
			message.error(text);
		};
		if (aoi.isDirty) return stop("Please save the AOI edits before saving the review.");
		const { reviews, problems } = reviewAnswers(values, dataset.id, result);
		if (problems.length) return stop(problems[0]);
		if (!requireAuditLease()) return stop("Nothing was saved.");

		setIsSubmitting(true);
		try {
			if (reviews.length) {
				await saveReviews(reviews);
				trackAppEvent("audit_completed", { dataset_id: dataset.id, final_assessment: values.decision ?? "unchanged" });
			}
			// the next draft starts from what is stored now
			const { data: stored } = await resultQuery.refetch();
			form.resetFields();
			form.setFieldsValue(initialDraft(stored ?? result));
			setStartDraft(initialDraft(stored ?? result));
			if (reviews.length) thankYou();
			else message.info("Nothing changed, so nothing was saved.");
			leave();
		} catch (error) {
			console.error("Error saving the review:", error);
			message.error(isAuditLeaseConflict(error) ? "Another review page holds this dataset. Your answers were not saved." : "Your answers were not saved. Please try again.");
		} finally {
			setIsSubmitting(false);
			navigateToNext.current = false;
		}
	};

	const handleSaveAndNext = () => {
		navigateToNext.current = true;
		form.submit();
	};

	const handleCancel = () => showExitConfirmation(() => navigate(listPath));

	return {
		form,
		handleSubmit,
		handleSaveAndNext,
		handleCancel,

		isLoading: !user || isLockingAudit || resultQuery.isLoading,
		isSaving: isSubmitting,
		auditLockError,
		isLockingAudit,
		auditLockLostMessage,
		auditLeaseId,
		auditOpenElsewhereMessage,
		continueAuditHere,

		result,
		resultFailed: resultQuery.isError,
		auditReviews: auditReviewsQuery.data,
		cogMetadata,
		isCogLoading,
		dateEstimate,
		georefCheck,
		auditChecks,
		auditChecksFailed: auditChecksQuery.isError || auditReviewsQuery.isError,
		retryChecks: () => {
			void auditChecksQuery.refetch();
			void auditReviewsQuery.refetch();
			void resultQuery.refetch();
		},

		nextDatasetId,

		aoi: { ...aoi, handleSave: handleSaveAOI },

		isDownloading,
		startDownload,
		finishDownload,
		currentDownloadId,
	};
}
