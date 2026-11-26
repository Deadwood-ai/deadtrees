"""Prediction quality check v1: vision models judge deadwood and forest predictions on CLIP tiles.

The check cuts crops on the CLIP embedding grid (512 px at 10 cm, 51.2 m), renders them at
5 cm with the deadwood and forest overlays, asks the judges per crop and layer, and keeps every
answer. The audit counts each layer's crop calls from the stored answers with the version's
crop cuts, so a new cut needs no new model calls; the check stores no dataset verdict. The
audit worker runs it through `handler.handle`; see docs/prediction-quality.md.
"""
