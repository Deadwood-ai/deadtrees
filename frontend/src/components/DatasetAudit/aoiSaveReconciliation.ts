export type AOIGeometry = GeoJSON.MultiPolygon | GeoJSON.Polygon;

const serializeGeometry = (geometry: AOIGeometry | null) =>
	geometry ? JSON.stringify(geometry) : "";

export function reconcileAOISave(
	currentGeometry: AOIGeometry | null,
	submittedGeometry: AOIGeometry,
	savedGeometry: AOIGeometry,
) {
	if (serializeGeometry(currentGeometry) === serializeGeometry(submittedGeometry)) {
		return {
			currentGeometry: savedGeometry,
			isDirty: false,
			hasNewerEdits: false,
		};
	}

	return {
		currentGeometry,
		isDirty: serializeGeometry(currentGeometry) !== serializeGeometry(savedGeometry),
		hasNewerEdits: true,
	};
}
