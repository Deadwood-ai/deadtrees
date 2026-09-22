export const FACTORY_SELECTION_STORAGE_KEY = "deadtrees.factory.selection";

export function addIds(current: number[], ids: number[]): number[] {
	const next = [...current];
	const seen = new Set(current);
	ids.forEach((id) => {
		if (!seen.has(id)) {
			seen.add(id);
			next.push(id);
		}
	});
	return next;
}

export function removeIds(current: number[], ids: number[]): number[] {
	const drop = new Set(ids);
	return current.filter((id) => !drop.has(id));
}

export function toggleId(current: number[], id: number): number[] {
	return current.includes(id) ? removeIds(current, [id]) : addIds(current, [id]);
}

export function readStoredSelection(storage: Storage | undefined): number[] {
	if (!storage) return [];
	try {
		const raw = storage.getItem(FACTORY_SELECTION_STORAGE_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((value): value is number => Number.isInteger(value) && value > 0);
	} catch {
		return [];
	}
}

export function writeStoredSelection(storage: Storage | undefined, ids: number[]): void {
	if (!storage) return;
	try {
		if (ids.length === 0) {
			storage.removeItem(FACTORY_SELECTION_STORAGE_KEY);
		} else {
			storage.setItem(FACTORY_SELECTION_STORAGE_KEY, JSON.stringify(ids));
		}
	} catch {
		// Session storage is a convenience; selection still lives in memory.
	}
}

export function formatIdList(ids: number[]): string {
	return ids.join(", ");
}
