export type AOIGeometry = GeoJSON.MultiPolygon | GeoJSON.Polygon;

const serializeGeometry = (geometry: AOIGeometry | null) =>
	geometry ? JSON.stringify(geometry) : "";

export const isSameAOIGeometry = (
	left: AOIGeometry | null,
	right: AOIGeometry | null,
) => serializeGeometry(left) === serializeGeometry(right);

export function reconcileAOIChange(
	geometry: AOIGeometry | null,
	savedGeometry: AOIGeometry | null,
	serverGeometry: AOIGeometry | null,
) {
	const matchesServer = isSameAOIGeometry(geometry, serverGeometry);

	return {
		savedGeometry: matchesServer ? serverGeometry : savedGeometry,
		isDirty: !matchesServer && !isSameAOIGeometry(geometry, savedGeometry),
	};
}

export function reconcileAOISave(
	currentGeometry: AOIGeometry | null,
	submittedGeometry: AOIGeometry,
	savedGeometry: AOIGeometry,
) {
	if (isSameAOIGeometry(currentGeometry, submittedGeometry)) {
		return {
			currentGeometry: savedGeometry,
			isDirty: false,
			hasNewerEdits: false,
		};
	}

	return {
		currentGeometry,
		isDirty: !isSameAOIGeometry(currentGeometry, savedGeometry),
		hasNewerEdits: true,
	};
}
