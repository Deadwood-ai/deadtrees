import { QUALITY_WORDS } from "./useLayerRating";

interface LayerRatingLineProps {
	rating: { quality: keyof typeof QUALITY_WORDS; major: number; counted: number };
	/** what follows the counts, e.g. how many crops you answered */
	extra?: string;
}

/** A prediction layer's rating from its crops, in the sidebar and above the crop review. */
export default function LayerRatingLine({ rating, extra }: LayerRatingLineProps) {
	return (
		<span className="text-xs" data-testid="audit-layer-rating">
			Layer rating from the crops: <b>{QUALITY_WORDS[rating.quality]}</b>
			<span className="text-gray-500">
				{" "}
				· {rating.major} major of {rating.counted} counted crops{extra ? ` · ${extra}` : ""}
			</span>
		</span>
	);
}
