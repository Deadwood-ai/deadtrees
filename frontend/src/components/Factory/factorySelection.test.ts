import { describe, expect, it } from "vitest";
import {
	FACTORY_SELECTION_STORAGE_KEY,
	addIds,
	formatIdList,
	readStoredSelection,
	removeIds,
	toggleId,
	writeStoredSelection,
} from "./factorySelection";

class MemoryStorage implements Storage {
	private map = new Map<string, string>();
	get length() {
		return this.map.size;
	}
	clear() {
		this.map.clear();
	}
	getItem(key: string) {
		return this.map.get(key) ?? null;
	}
	key(index: number) {
		return Array.from(this.map.keys())[index] ?? null;
	}
	removeItem(key: string) {
		this.map.delete(key);
	}
	setItem(key: string, value: string) {
		this.map.set(key, value);
	}
}

describe("selection helpers", () => {
	it("keeps insertion order and ignores duplicates", () => {
		expect(addIds([3, 1], [1, 2, 2])).toEqual([3, 1, 2]);
		expect(removeIds([3, 1, 2], [1])).toEqual([3, 2]);
		expect(toggleId([3], 3)).toEqual([]);
		expect(toggleId([3], 4)).toEqual([3, 4]);
		expect(formatIdList([3, 4])).toBe("3, 4");
	});

	it("persists to storage and tolerates corrupt values", () => {
		const storage = new MemoryStorage();
		writeStoredSelection(storage, [5, 6]);
		expect(readStoredSelection(storage)).toEqual([5, 6]);
		writeStoredSelection(storage, []);
		expect(storage.getItem(FACTORY_SELECTION_STORAGE_KEY)).toBeNull();
		storage.setItem(FACTORY_SELECTION_STORAGE_KEY, "{bad json");
		expect(readStoredSelection(storage)).toEqual([]);
		storage.setItem(FACTORY_SELECTION_STORAGE_KEY, JSON.stringify([1, "x", -2, 7]));
		expect(readStoredSelection(storage)).toEqual([1, 7]);
		expect(readStoredSelection(undefined)).toEqual([]);
	});
});
