---
name: d2-diagrams
description: Create publication-quality diagrams using D2 with an iterative render-review-refine loop. Use when the user says "diagram", "d2", "dataflow", "architecture diagram", "system diagram", "web app diagram", or needs to create technical visualizations for papers, docs, or presentations.
---

# D2 Diagram Creation (Iterative Loop)

Create polished, publication-ready diagrams using D2 with a tight generate-render-review-refine cycle.

## Prerequisites

- **D2** installed: `curl -fsSL https://d2lang.com/install.sh | sh -a`
- **Playwright** (optional, for screenshot embedding): `pip install playwright && playwright install chromium`

## Core Loop

Every diagram follows this cycle until the user is satisfied:

```
1. Define/edit .d2 file
2. Render to SVG + PNG
3. Read the PNG to visually inspect
4. Identify issues (spacing, color, typography, layout)
5. Refine .d2 and/or render flags
6. Repeat from 2
```

**Be self-critical at step 4.** Compare against reference images if provided. Check: padding, arrow subtlety, font weight, color contrast, compactness.

---

## Dark Theme Style (Proven Defaults)

This palette produces clean, modern diagrams inspired by Cursor blog aesthetics:

```d2
classes: {
  node: {
    style: {
      fill: "#2c2c30"
      stroke: "#404046"
      font-color: "#d8d8dc"
      border-radius: 5
      font-size: 18
      stroke-width: 1
    }
  }
  hub: {
    style: {
      fill: "#3c3c42"
      stroke: "#505058"
      font-color: "#f0f0f2"
      border-radius: 5
      font-size: 18
      stroke-width: 1
    }
  }
  ml: {
    style: {
      fill: "#1c1c20"
      stroke: "#404046"
      font-color: "#d8d8dc"
      border-radius: 5
      font-size: 18
      stroke-width: 1
    }
  }
  store: {
    style: {
      fill: "#2c2c30"
      stroke: "#404046"
      font-color: "#d8d8dc"
      border-radius: 5
      font-size: 18
      stroke-width: 1
    }
  }
}
```

**Color roles:**
- `node` (#2c2c30): Standard boxes
- `hub` (#3c3c42): Central/important nodes (slightly lighter)
- `ml` (#1c1c20): ML/model nodes (slightly darker)
- `store` (#2c2c30 + `shape: cylinder`): Data stores

**Edge color:** `{style.stroke: "#404046"}` — subtle, not dominant

---

## Render Command

```bash
d2 \
  --theme=302 \
  --layout=elk \
  --elk-nodeNodeBetweenLayers=20 \
  --elk-edgeNodeBetweenLayers=10 \
  --elk-padding="[top=10,left=10,bottom=10,right=10]" \
  --pad=15 \
  --scale=2 \
  --font-regular=/path/to/Inter-Medium.ttf \
  --font-bold=/path/to/Inter-SemiBold.ttf \
  --font-italic=/path/to/Inter-Italic.ttf \
  input.d2 output.svg
```

Then convert SVG to PNG:
```bash
d2 \
  --theme=302 \
  --layout=elk \
  --elk-nodeNodeBetweenLayers=20 \
  --elk-edgeNodeBetweenLayers=10 \
  --elk-padding="[top=10,left=10,bottom=10,right=10]" \
  --pad=15 \
  --scale=2 \
  input.d2 output.png
```

D2 natively outputs PNG when the extension is `.png`.

### Key Flags Explained

| Flag | Purpose | Tuning guidance |
|------|---------|-----------------|
| `--theme=302` | Terminal Royal dark theme | Use 200/201 for other dark variants |
| `--layout=elk` | ELK layout engine (best for DAGs) | dagre is an alternative |
| `--elk-nodeNodeBetweenLayers` | Space between node columns | Lower = more compact (20 is tight) |
| `--elk-edgeNodeBetweenLayers` | Space between edges and nodes | Lower = tighter arrows (10 is tight) |
| `--elk-padding` | Internal padding of containers | Reduce for compactness |
| `--pad` | Canvas padding around the diagram | 15 is minimal |
| `--scale` | Output scale multiplier | 2 for high-res paper/print |
| `--font-*` | Custom fonts | Inter family recommended |

---

## Diagram Patterns

### Dataflow / Pipeline

```d2
direction: right

input1: Input A { class: node }
input2: Input B { class: node }
process: Process { class: hub }
output: Output { class: node }

input1 -> process: {style.stroke: "#404046"}
input2 -> process: {style.stroke: "#404046"}
process -> output: {style.stroke: "#404046"}
```

### Embedded Screenshots (Web App Diagrams)

Use `shape: image` inside containers for screenshot embedding:

```d2
classes: {
  screen: {
    style: {
      fill: "#22222a"
      stroke: "#404046"
      border-radius: 8
      font-color: "#d8d8dc"
      font-size: 16
      stroke-width: 1
      shadow: true
    }
  }
}

page1: {
  class: screen
  label: Page Name
  "": {
    shape: image
    icon: screenshots/page1.png
    width: 400
    height: 225
  }
}
```

**Important:** Use `""` as the image node label to suppress D2's automatic "img" label.

### Capturing Screenshots with Playwright

```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1920, "height": 1080})
    page.goto("https://example.com", wait_until="networkidle")
    page.screenshot(path="screenshots/page.png", type="png")
    browser.close()
```

---

## Iteration Checklist

After each render, check:

1. **Compactness** — Is there wasted whitespace? Reduce `elk-nodeNodeBetweenLayers`, `elk-padding`, `pad`
2. **Arrow subtlety** — Are arrows too thick or dominant? Use `style.stroke` with muted colors
3. **Box-to-label ratio** — Too much padding inside boxes? Adjust `font-size` and `--scale`
4. **Color contrast** — Can you read labels? Dark text on dark bg needs careful tuning
5. **Typography** — Font weight appropriate? Use Inter SemiBold for labels
6. **Layout flow** — Does the diagram read left-to-right or top-to-bottom naturally?
7. **Hierarchy** — Are important nodes visually distinct? Use `hub` class for central nodes

## Common Fixes

| Problem | Solution |
|---------|----------|
| Arrows too long | Decrease `--elk-nodeNodeBetweenLayers` |
| Too much whitespace | Decrease `--pad` and `--elk-padding` |
| Boxes too large relative to text | Increase `--scale` (counter-intuitive: makes text relatively larger) |
| Arrows too prominent | Use lighter stroke color (`#404046` or `#505058`) |
| Font too thin/bold | Switch `--font-regular` / `--font-bold` files |
| "img" label on image nodes | Set image node label to `""` |
| Layout direction wrong | Change `direction: right` / `down` / `left` / `up` |

## Structural Variants

When restructuring, propose multiple variants as text before rendering. Common patterns:

- **Horizontal flow** (`direction: right`): Best for pipelines
- **Vertical grouped**: Best for layered architectures
- **Three-column**: Input | Processing | Output
- **Unified data store**: Fan-in to a single `cylinder` node
- **Branch paths**: E.g., ODM preprocessing branch before main pipeline

Present 3-4 variants, let the user pick, then render only the chosen one.

---

## File Organization

```
diagrams/
├── dataflow.d2           # D2 source
├── webapp.d2             # Another diagram
├── dataflow.png          # Rendered output (high-res)
├── dataflow.svg          # SVG output
├── screenshots/          # Captured page screenshots
│   ├── landing.png
│   └── browser.png
└── fonts/                # Custom fonts (optional)
    ├── Inter-Medium.ttf
    └── Inter-SemiBold.ttf
```
