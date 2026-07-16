import { useCallback, useEffect, useRef, useState } from "react";
import { message } from "antd";

import { useDatasetAOI, useSaveDatasetAOI } from "../../hooks/useDatasetAudit";
import type { AOIToolbarState } from "../DatasetDetailsMap/hooks/useAOIEditor";
import {
	type AOIGeometry,
	isSameAOIGeometry,
	reconcileAOIChange,
	reconcileAOISave,
} from "./aoiSaveReconciliation";

const EMPTY_TOOLBAR_STATE: AOIToolbarState = {
	isDrawing: false,
	drawingMode: null,
	isEditing: false,
	hasAOI: false,
	isAOILoading: true,
	selectionCount: 0,
	polygonCount: 0,
	canUndo: false,
};

export function useAuditAOIState(datasetId: number) {
	const currentGeometryRef = useRef<AOIGeometry | null>(null);
	const savedGeometryRef = useRef<AOIGeometry | null>(null);
	const hasLoadedSavedAOIRef = useRef(false);
	const [hasAOI, setHasAOI] = useState(false);
	const [isLoaded, setIsLoaded] = useState(false);
	const [isDirty, setIsDirty] = useState(false);
	const [toolbarState, setToolbarState] = useState<AOIToolbarState>(EMPTY_TOOLBAR_STATE);

	const { data: aoiData, isLoading } = useDatasetAOI(datasetId);
	const { mutateAsync: saveAOI, isPending: isSaving } = useSaveDatasetAOI();
	const serverGeometry = aoiData?.geometry
		? aoiData.geometry as AOIGeometry
		: null;

	useEffect(() => {
		currentGeometryRef.current = null;
		savedGeometryRef.current = null;
		hasLoadedSavedAOIRef.current = false;
		setHasAOI(false);
		setIsLoaded(false);
		setIsDirty(false);
		setToolbarState(EMPTY_TOOLBAR_STATE);
	}, [datasetId]);

	useEffect(() => {
		if (isLoading) return;

		if (hasLoadedSavedAOIRef.current) {
			if (isSameAOIGeometry(currentGeometryRef.current, savedGeometryRef.current)) {
				currentGeometryRef.current = serverGeometry;
				savedGeometryRef.current = serverGeometry;
				setHasAOI(!!serverGeometry);
				setIsDirty(false);
			}
			return;
		}

		savedGeometryRef.current = serverGeometry;
		hasLoadedSavedAOIRef.current = true;
		const currentGeometry = currentGeometryRef.current;
		if (currentGeometry && !isSameAOIGeometry(currentGeometry, serverGeometry)) {
			setHasAOI(true);
			setIsDirty(true);
			setIsLoaded(true);
			return;
		}

		currentGeometryRef.current = serverGeometry;
		setHasAOI(!!serverGeometry);
		setIsDirty(false);
		setIsLoaded(true);
	}, [isLoading, serverGeometry]);

	const handleChange = useCallback((geometry: AOIGeometry | null) => {
		currentGeometryRef.current = geometry;
		setHasAOI(!!geometry);
		setIsLoaded(true);

		const reconciliation = reconcileAOIChange(
			geometry,
			savedGeometryRef.current,
			serverGeometry,
		);
		savedGeometryRef.current = reconciliation.savedGeometry;
		setIsDirty(hasLoadedSavedAOIRef.current && reconciliation.isDirty);
	}, [serverGeometry]);

	const handleSave = useCallback(async () => {
		const geometry = currentGeometryRef.current;
		if (!geometry) {
			message.warning("Draw an AOI before saving it.");
			return;
		}
		try {
			const savedAOI = await saveAOI({
				dataset_id: datasetId,
				geometry,
				is_whole_image: false,
			});
			const savedGeometry = savedAOI.geometry as AOIGeometry;
			savedGeometryRef.current = savedGeometry;
			const reconciliation = reconcileAOISave(
				currentGeometryRef.current,
				geometry,
				savedGeometry,
			);
			currentGeometryRef.current = reconciliation.currentGeometry;
			setHasAOI(!!reconciliation.currentGeometry);
			setIsDirty(reconciliation.isDirty);
			message.success(
				reconciliation.hasNewerEdits
					? "AOI saved. Newer edits remain unsaved."
					: "AOI saved"
			);
		} catch (error) {
			console.error("Failed to save AOI:", error);
			message.error("Failed to save AOI");
		}
	}, [datasetId, saveAOI]);

	return {
		currentGeometryRef,
		hasAOI,
		isLoaded,
		isDirty,
		isSaving,
		toolbarState,
		setToolbarState,
		handleChange,
		handleSave,
	};
}
