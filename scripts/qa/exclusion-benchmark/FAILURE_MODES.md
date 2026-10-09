# Prediction failure modes and screening design (draft, 9 Oct 2026)

Draft for Janusch to correct. Grounded in all 7,293 human audits (338 deadwood notes,
339 forest notes, 1,059 general notes), the Sol and Decisions runs, his box verdicts and
the 40 labeled test crops.

## Why the satellite product decides what matters

The product is fractional deadwood and forest cover per 10 m Sentinel pixel. An error
matters when it shifts cover fractions across many 10 m cells, not when a boundary is a
little loose. So every mode below is judged by **how much area it affects**, and modes
that only move a few square metres (loose outlines, one missed sapling) are not failures.

## The eight modes (merged from the overlapping lists so far)

| # | Mode | Layer | What it looks like | Audit notes (all / graded Bad) | Satellite impact |
|---|---|---|---|---|---|
| 1 | **Dead trees missed** | Deadwood | Standing dead or dying crowns without blue: grey/white snags, burnt crowns, brown/red beetle or drought kill. Partial crowns count here only when large dead parts are left out. | 184 / 73 (+45 partial, +37 brown, +9 burnt) | Underestimates mortality, the main product signal |
| 2 | **Live vegetation marked dead** | Deadwood | Blue on green or coloured foliage, flowering trees, shrubs, grass, crops | 21 / 12 | False mortality hotspots |
| 3 | **Non-vegetation marked dead** | Deadwood | Blue on ground, rock, roads, roofs, water, snow, deep shadow | 40 / 25 | False mortality, often in large patches (water, snow) |
| 4 | **Lying wood marked dead** | Deadwood | Blue on fallen trunks, logs, debris (common in burned and storm sites) | 10 / 3, and your box verdicts | Overestimates standing mortality |
| 5 | **Trees missed** | Forest | Tree canopy or whole stands without gold | 108 / 38 | Underestimates forest, distorts the denominator for deadwood share |
| 6 | **Non-trees marked as forest** | Forest | Gold on shrubs, crops, grass, ground or roofs, including filled gaps between crowns | 110 / 36 (shrubs/crops 66, gaps 40) | Overestimates forest |
| 7 | **Processing artifacts** | Both | Straight tile seams, rectangular holes or blocks, missing or cut-off layer, stripes | 213 / 77 (forest 152, deadwood 61) | Blocks of zero or full cover, large bias |
| 8 | **Season / phenology** | Deadwood (scene) | Leaf-off or autumn colours making live trees look dead, so blue spreads widely | 13 / 9, plus 900 audits flagged out of season | Systematic overestimate across the scene |

Not a prediction failure, but an exclusion reason: **image not assessable** (blur,
stitching ghosts, not RGB, nodata, too coarse). It is handled as "unsure", see below.

### Conventions that need your decision

These are where auditors, reference editors and you currently disagree. The model can
only match one written rule.

1. **Dead trees in the forest layer**: is a standing dead tree "forest"? (28 audit notes
   say forest misses dead trees; v5 told Sol not to count it.)
2. **Lying wood**: never deadwood? (your verdicts: yes, never.)
3. **Partial crowns**: when does a partly dead crown count as missed deadwood?
4. **Shrubs vs trees**: is there a size or height cut (e.g. 1 m, 3 m) for forest?
5. **How big is "substantial"**: proposal below (more than about 20% of the crop's own class
   or about 5% of the crop area).

## Crops: size, resolution, coverage

- **Resolution: native, capped at about 5 cm per pixel.** Dead crowns and branches are
  invisible on the 20 cm grid views. Decisions saw the forest overlay at AUC 0.95 on native
  crops but only 0.75 on grid views. Finer imagery (median 3.6 cm) is downsampled to 5 cm so
  every crop looks alike.
- **Size: 51.2 m × 51.2 m (1,024 px at 5 cm).** That's 5 × 5 Sentinel pixels, the same
  size as the reference patches (so the human-corrected patches are directly usable as
  truth). It also gives enough context to tell a dead crown from bare ground.
- **Coverage: about 20 crops per dataset, stratified.** A median dataset (20 ha) holds
  about 76 such crops. Sample about 20 (roughly 25% of the area): spread evenly over the
  area, plus extra crops where predicted deadwood is highest and where there is canopy but
  no prediction, so omissions get looked at too. Cost about $0.008 per dataset with
  Decisions.
- **One overview per dataset** for scene-level modes (7 processing artifacts, 8 season),
  together with the deterministic seam linter.

## Uncertain cases

- **Per crop, a gate question first**: "Is this crop assessable (sharp, in season, trees
  visible, not mostly shadow or nodata)?" Unassessable crops are dropped from aggregation,
  not counted as OK or bad.
- **Per mode, three outcomes**: yes (above 0.7), no (below 0.3), unsure in between. Unsure
  answers don't count toward exclusion.
- **Per dataset**: if more than about a third of crops are unassessable or unsure, the
  dataset goes to a human ("needs review") instead of keep/exclude.
- **In human labels**: "?" is kept separate from blank and excluded from scoring. The share
  of "?" is tracked, because it measures how ambiguous each mode is.

## The loop that can be tuned and evaluated continuously

1. **Two gold sets, both frozen per version.**
   - Crop gold: your labeled crops (40 now; target about 200, at least 15 clear positives
     per mode, half held out and never used for tuning). Reference patches with measured
     errors serve as extra positives once the conventions match.
   - Dataset gold: adjudicated datasets (keep/exclude per layer).
2. **Per-mode detector score.** On crop gold: share of true problems caught at a fixed
   false-alarm rate (e.g. 10%). Any change (wording, context, crop size, model) is promoted
   only if it beats the current version on the held-out half.
3. **Aggregation to a dataset decision.** Per mode, the flagged share of sampled crop area,
   plus the seam linter and the audit-trained classifier, feed a small model. Its cutoff is
   set on dataset gold for the target (catch at least 90% of Bad, wrongly exclude at most 20%).
4. **Feedback in production.** Auditors see the flagged crops with the mode named. Their
   right/wrong clicks become new crop gold, and their keep/exclude becomes dataset gold. Weekly:
   re-score, check drift per biome and season, promote only on improvement.
5. **Where each model fits.** Decisions as the cheap per-crop detector for modes 1–7 at
   scale. The linter for mode 7. Sol (boxes) for crops the cheap stage marks as unsure or
   borderline. A fine-tunable open model later, once crop gold is large enough to train on.
