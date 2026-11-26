"""Prediction quality check v1: vision models judge deadwood and forest predictions on CLIP tiles.

The check picks tiles on the CLIP embedding grid (512 px at 10 cm, 51.2 m), renders them at
5 cm with the deadwood and forest overlays, asks the judges per tile and layer, and keeps every
answer. The database works out each tile's call from the stored answers with the version's
rules (audit.tile_calls), so new rules need no new model calls; the check stores no dataset
verdict. The audit worker runs it through `handler.handle`; see docs/prediction-quality.md.
"""
