import { IBiome } from "../types/dataset";

type BiomeDisplay = {
	emoji: string;
	color: string;
};

const BIOME_DISPLAY_MAP: Record<string, BiomeDisplay> = {
	[IBiome.TropicalMoistForests]: { emoji: "🌴", color: "green" },
	[IBiome.TropicalDryForests]: { emoji: "🌵", color: "gold" },
	[IBiome.TropicalConiferousForests]: { emoji: "🌲", color: "lime" },
	[IBiome.TemperateBroadleafForests]: { emoji: "🍂", color: "blue" },
	[IBiome.TemperateConiferousForests]: { emoji: "🌲", color: "geekblue" },
	[IBiome.BorealForests]: { emoji: "❄️", color: "cyan" },
	[IBiome.TropicalGrasslands]: { emoji: "🌾", color: "volcano" },
	[IBiome.TemperateGrasslands]: { emoji: "🌾", color: "orange" },
	[IBiome.FloodedGrasslands]: { emoji: "💧", color: "blue" },
	[IBiome.MontaneGrasslands]: { emoji: "⛰️", color: "purple" },
	[IBiome.Tundra]: { emoji: "🧊", color: "cyan" },
	[IBiome.MediterraneanForests]: { emoji: "🫒", color: "gold" },
	[IBiome.Deserts]: { emoji: "🏜️", color: "volcano" },
	[IBiome.Mangroves]: { emoji: "🌊", color: "green" },
};

const BIOME_KEYWORD_FALLBACKS: Array<{ keyword: string; biome: IBiome }> = [
	{ keyword: "mangrove", biome: IBiome.Mangroves },
	{ keyword: "tundra", biome: IBiome.Tundra },
	{ keyword: "desert", biome: IBiome.Deserts },
	{ keyword: "mediterranean", biome: IBiome.MediterraneanForests },
	{ keyword: "boreal", biome: IBiome.BorealForests },
	{ keyword: "taiga", biome: IBiome.BorealForests },
	{ keyword: "montane", biome: IBiome.MontaneGrasslands },
	{ keyword: "flooded", biome: IBiome.FloodedGrasslands },
	{ keyword: "temperate coniferous", biome: IBiome.TemperateConiferousForests },
	{ keyword: "temperate broadleaf", biome: IBiome.TemperateBroadleafForests },
	{ keyword: "temperate grasslands", biome: IBiome.TemperateGrasslands },
	{ keyword: "tropical and subtropical moist broadleaf", biome: IBiome.TropicalMoistForests },
	{ keyword: "tropical and subtropical dry broadleaf", biome: IBiome.TropicalDryForests },
	{ keyword: "tropical and subtropical coniferous", biome: IBiome.TropicalConiferousForests },
	{ keyword: "tropical and subtropical grasslands", biome: IBiome.TropicalGrasslands },
];

const UNKNOWN_BIOME_DISPLAY: BiomeDisplay = {
	emoji: "❓",
	color: "default",
};

const resolveBiomeDisplay = (biomeName: string | null | undefined): BiomeDisplay => {
	if (!biomeName) {
		return UNKNOWN_BIOME_DISPLAY;
	}

	const exact = BIOME_DISPLAY_MAP[biomeName];
	if (exact) {
		return exact;
	}

	const normalized = biomeName.toLowerCase();
	const matched = BIOME_KEYWORD_FALLBACKS.find((item) => normalized.includes(item.keyword));
	if (matched) {
		return BIOME_DISPLAY_MAP[matched.biome];
	}

	return UNKNOWN_BIOME_DISPLAY;
};

export const getBiomeEmoji = (biomeName: string | null | undefined): string => {
	return resolveBiomeDisplay(biomeName).emoji;
};

export const getBiomeTagColor = (biomeName: string | null | undefined): string => {
	return resolveBiomeDisplay(biomeName).color;
};

export const truncateBiomeLabel = (label: string, maxChars = 10): string => {
	if (label.length <= maxChars) {
		return label;
	}
	return `${label.slice(0, maxChars)}...`;
};
