import type { MutableRefObject } from "react";
import { useEffect, useRef } from "react";
import { Map } from "ol";
import TileLayerWebGL from "ol/layer/WebGLTile.js";

import {
  createPriwaBefallsgruppeFeature,
  createPriwaBefallsgruppeLayer,
} from "./createPriwaBefallsgruppeLayer";
import { createPriwaCogLayers } from "./createPriwaCogLayer";
import {
  createPriwaMosaicFootprintFeature,
  createPriwaMosaicFootprintLayer,
} from "./createPriwaMosaicFootprintLayer";
import type { IPriwaBefallsgruppe, IPriwaPoint } from "./types";
import type { IPriwaMosaic } from "./usePriwaMosaics";
import type { IPriwaMatchedMosaic } from "./usePriwaMosaicMatches";

type PriwaBefallsgruppeLayer = ReturnType<
  typeof createPriwaBefallsgruppeLayer
>;
type PriwaMosaicFootprintLayer = ReturnType<
  typeof createPriwaMosaicFootprintLayer
>;
type PriwaBefallsgruppeSource = NonNullable<
  ReturnType<PriwaBefallsgruppeLayer["getSource"]>
>;
type PriwaMosaicFootprintSource = NonNullable<
  ReturnType<PriwaMosaicFootprintLayer["getSource"]>
>;

interface UsePriwaReviewMapLayersOptions {
  mapRef: MutableRefObject<Map | null>;
  groupLayerRef: MutableRefObject<PriwaBefallsgruppeLayer | null>;
  mosaicFootprintLayerRef: MutableRefObject<PriwaMosaicFootprintLayer | null>;
  groups: IPriwaBefallsgruppe[];
  points: IPriwaPoint[];
  matchedMosaics: IPriwaMatchedMosaic[];
  reviewMosaics: IPriwaMosaic[];
  enabledMosaics: IPriwaMosaic[];
  enabledMosaicIds: Set<string>;
  selectedMosaicId: string | null;
}

export const syncPriwaBefallsgruppeLayer = (
  source: PriwaBefallsgruppeSource,
  groups: IPriwaBefallsgruppe[],
  points: IPriwaPoint[],
) => {
  source.clear();
  groups.forEach((group) => {
    const feature = createPriwaBefallsgruppeFeature(group, points);
    if (feature) source.addFeature(feature);
  });
};

export const syncPriwaMosaicFootprintLayer = (
  source: PriwaMosaicFootprintSource,
  matchedMosaics: IPriwaMatchedMosaic[],
  reviewMosaics: IPriwaMosaic[],
  enabledMosaicIds: Set<string>,
  selectedMosaicId: string | null,
) => {
  source.clear();
  const matchedIds = new Set(matchedMosaics.map(({ mosaic }) => mosaic.id));
  reviewMosaics
    .filter(
      (mosaic) =>
        matchedIds.has(mosaic.id) ||
        enabledMosaicIds.has(mosaic.id) ||
        mosaic.id === selectedMosaicId,
    )
    .forEach((mosaic) => {
      const feature = createPriwaMosaicFootprintFeature({
        mosaic,
        isSelected: mosaic.id === selectedMosaicId,
        isVisible: enabledMosaicIds.has(mosaic.id),
      });
      if (feature) source.addFeature(feature);
    });
};

export function usePriwaReviewMapLayers({
  mapRef,
  groupLayerRef,
  mosaicFootprintLayerRef,
  groups,
  points,
  matchedMosaics,
  reviewMosaics,
  enabledMosaics,
  enabledMosaicIds,
  selectedMosaicId,
}: UsePriwaReviewMapLayersOptions) {
  const cogLayersRef = useRef<TileLayerWebGL[]>([]);

  useEffect(() => {
    const source = groupLayerRef.current?.getSource();
    if (source) syncPriwaBefallsgruppeLayer(source, groups, points);
  }, [groupLayerRef, groups, points]);

  useEffect(() => {
    const source = mosaicFootprintLayerRef.current?.getSource();
    if (source) {
      syncPriwaMosaicFootprintLayer(
        source,
        matchedMosaics,
        reviewMosaics,
        enabledMosaicIds,
        selectedMosaicId,
      );
    }
  }, [
    enabledMosaicIds,
    matchedMosaics,
    mosaicFootprintLayerRef,
    reviewMosaics,
    selectedMosaicId,
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    cogLayersRef.current.forEach((layer) => map.removeLayer(layer));
    const cogLayers = createPriwaCogLayers(enabledMosaics);
    cogLayersRef.current = cogLayers;
    cogLayers.forEach((layer, index) => {
      layer.setZIndex(20 + (enabledMosaics.length - index) / 100);
      map.getLayers().insertAt(2 + index, layer);
    });

    return () => {
      cogLayers.forEach((layer) => map.removeLayer(layer));
      if (cogLayersRef.current === cogLayers) cogLayersRef.current = [];
    };
  }, [enabledMosaics, mapRef]);
}
