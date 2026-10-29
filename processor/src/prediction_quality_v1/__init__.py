"""Prediction quality check v1: vision models judge deadwood and forest predictions on CLIP tiles.

The check cuts crops on the CLIP embedding grid (512 px at 10 cm, 51.2 m), renders them at
5 cm with the deadwood and forest overlays, asks the judges per crop and layer, and keeps every
answer. The dataset verdict is derived from the stored crop answers by a versioned rule, so it
can be recomputed without new model calls. See DT-1484 and the audit plan (DT-1470).
"""
