import type { CSSProperties } from "react";
import { auditImageUrl } from "../../../api/auditImages";
import { useAuditImageAccess } from "../../../hooks/useAuditChecks";
import type { IAuditImage } from "../../../types/auditChecks";
import { InlineLoadError, InlineSkeleton } from "../../SectionStates";

interface CropImageProps {
	image: IAuditImage;
	className?: string;
	style?: CSSProperties;
	/** a layer under another image: hidden from screen readers */
	decorative?: boolean;
}

/** One stored check image behind the auditors' signed link; mounting it is what asks for the ticket. */
export default function CropImage({ image, className = "h-auto w-full rounded border border-gray-200", style, decorative = false }: CropImageProps) {
	const access = useAuditImageAccess();
	// a layer under another image leaves loading and errors to the image above it
	if (decorative && !access.data) return null;
	if (access.isError) return <InlineLoadError message="The images couldn’t load." onRetry={() => void access.refetch()} />;
	if (!access.data) return <InlineSkeleton label="Loading the model's image" className="aspect-square w-full" />;
	return (
		<img
			src={auditImageUrl(access.data, image.storage_path)}
			alt={decorative ? "" : `What the model saw: ${image.kind.replace(/_/g, " ")}`}
			aria-hidden={decorative || undefined}
			className={className}
			style={style}
			width={image.width}
			height={image.height}
			draggable={false}
		/>
	);
}
