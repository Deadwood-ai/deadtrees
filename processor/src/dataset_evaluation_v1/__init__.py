"""Dataset evaluation check: the first step of the automated audit (DT-1483).

Per dataset: read the COG overview and up to four crops on the CLIP tile grid, run the
deterministic band check, ask the vision models (Luna and Haiku), and combine everything
into one dataset verdict (keep, exclude, unsure) with the COG and thumbnail
issues as its output. The audit worker (DT-1482) runs it through `handler.handle`, and a
rule-only run through `handler.recompute`; see docs/dataset-evaluation.md.
"""
