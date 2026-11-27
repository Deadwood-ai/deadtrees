"""Dataset evaluation check: the first step of the automated audit (DT-1483).

Per dataset: read the COG overview and up to four tiles on the CLIP grid, run the
deterministic band check and ask the vision models (Luna and Haiku). The run stores every
model's judgement; the database turns them into keep, exclude or unsure with the COG and
thumbnail issues, by the version's rules. The audit worker (DT-1482) runs it through
`handler.handle`; see docs/dataset-evaluation.md.
"""
