# Technical Diagrams Playbook

Use this when the user asks for a diagram, architecture sketch, dataflow,
pipeline visualization, paper figure, or presentation graphic.

## Preferred Tools

- Mermaid for quick diagrams embedded in Markdown.
- D2 for polished standalone technical diagrams when D2 is installed locally.
- Playwright screenshots for browser-backed UI or app-flow diagrams.

## D2 Workflow

1. Draft a `.d2` file in an appropriate docs or scratch location.
2. Render to SVG and PNG.
3. Inspect the PNG visually.
4. Refine spacing, hierarchy, labels, arrows, and color.
5. Repeat until the diagram is readable at the target size.

Example render command:

```bash
d2 --layout=elk --theme=302 --pad 24 input.d2 output.svg
d2 --layout=elk --theme=302 --pad 24 input.d2 output.png
```

## Style Heuristics

- Prefer left-to-right flow for pipelines.
- Use vertical grouping for layered architecture.
- Keep arrows subtle so labels and nodes dominate.
- Use cylinders for databases or storage.
- Keep labels short and domain-specific.
- For DeadTrees, use restrained blue/green/deadwood accent colors and avoid
  decorative gradients.

## Review Checklist

- Is the reading order obvious?
- Are labels readable at final size?
- Is there unnecessary whitespace?
- Are edge crossings minimized?
- Does the diagram show actual product architecture or data flow, not a generic
  abstraction?
