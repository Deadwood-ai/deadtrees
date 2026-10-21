import { mapColors } from "../../theme/mapColors";
import { palette } from "../../theme/palette";

/**
 * Fill the map flag hover popup. Flag descriptions are written by any signed-in user
 * and shown to auditors, so they are set as text, never parsed as HTML.
 */
export function renderFlagHoverContent(
  element: HTMLElement,
  flag: { flagId: unknown; year?: unknown; description?: unknown },
): void {
  const container = document.createElement("div");
  container.style.fontFamily = "system-ui, sans-serif";

  const title = document.createElement("div");
  title.style.fontWeight = "600";
  title.style.color = mapColors.flag.stroke;
  title.style.marginBottom = "4px";
  title.textContent = `Flag #${flag.flagId}${flag.year ? ` · ${flag.year}` : ""}`;

  const description = document.createElement("div");
  description.style.color = palette.neutral[800];
  description.style.lineHeight = "1.4";
  description.textContent = flag.description == null ? "" : String(flag.description);

  container.append(title, description);
  element.replaceChildren(container);
}
