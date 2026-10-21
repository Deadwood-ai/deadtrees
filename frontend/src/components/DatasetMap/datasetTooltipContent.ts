/**
 * Fill the archive map hover tooltip. Titles come from dataset metadata, so they are
 * set as text, never parsed as HTML.
 */
export function renderDatasetTooltipContent(
  element: HTMLElement,
  title: unknown,
  date: unknown,
): void {
  const container = document.createElement("div");
  container.className = "tooltip-content";

  const line = document.createElement("div");
  line.textContent = `${title} (${date})`;

  container.append(line);
  element.replaceChildren(container);
}
