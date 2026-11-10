"""Dataset evaluation check v1: the first step of the automated audit (DT-1483).

Per dataset: read the COG overview and up to four crops on the CLIP tile grid, run the
deterministic band and duplicate rules, ask the vision models (Luna and Haiku), and
combine everything into one dataset verdict (keep, keep but fix, exclude, unsure). The
audit worker (DT-1482) runs it through `handler.handle`;
see docs/dataset-evaluation.md.
"""
