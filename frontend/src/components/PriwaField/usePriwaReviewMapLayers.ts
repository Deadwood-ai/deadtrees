import type { MutableRefObject } from "react";
import { useEffect, useRef } from "react";
import { Map as OlMap } from "ol";
import TileLayerWebGL from "ol/layer/WebGLTile.js";

import {
  createPriwaBefallsgruppeFeature,
  createPriwaBefallsgruppeLayer,
} from "./createPriwaBefallsgruppeLayer";
import { createPriwaCogLayer } from "./createPriwaCogLayer";
import {
  createPriwaMosaicFootprintFeature,
  createPriwaMosaicFootprintLayer,
} from "./createPriwaMosaicFootprintLayer";
import type { IPriwaBefallsgruppe, IPriwaPoint } from "./types";
import type { IPriwaMosaic } from "./usePriwaMosaics";
import type { IPriwaMatchedMosaic } from "./usePriwaMosaicMatches";

type PriwaBefallsgruppeLayer = ReturnType<typeof createPriwaBefallsgruppeLayer>;
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
  mapRef: MutableRefObject<OlMap | null>;
  groupLayerRef: MutableRefObject<PriwaBefallsgruppeLayer | null>;
  mosaicFootprintLayerRef: MutableRefObject<PriwaMosaicFootprintLayer | null>;
  groups: IPriwaBefallsgruppe[];
  points: IPriwaPoint[];
  matchedMosaics: IPriwaMatchedMosaic[];
  reviewMosaics: IPriwaMosaic[];
  enabledMosaics: IPriwaMosaic[];
  enabledMosaicIds: Set<string>;
  selectedMosaicId: string | null;
  selectedGroupId: string | null;
}

export const syncPriwaBefallsgruppeLayer = (
  source: PriwaBefallsgruppeSource,
  groups: IPriwaBefallsgruppe[],
  points: IPriwaPoint[],
  selectedGroupId: string | null = null,
) => {
  source.clear();
  groups.forEach((group) => {
    const feature = createPriwaBefallsgruppeFeature(
      group,
      points,
      group.id === selectedGroupId,
    );
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
  selectedGroupId,
}: UsePriwaReviewMapLayersOptions) {
  const cogLayersRef = useRef<
    globalThis.Map<string, { cogUrl: string; layer: TileLayerWebGL }>
  >(new globalThis.Map());

  useEffect(() => {
    const source = groupLayerRef.current?.getSource();
    if (source) {
      syncPriwaBefallsgruppeLayer(source, groups, points, selectedGroupId);
    }
  }, [groupLayerRef, groups, points, selectedGroupId]);

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

    const enabledMosaicIds = new Set(
      enabledMosaics.map((mosaic) => mosaic.id),
    );
    cogLayersRef.current.forEach(({ layer }, mosaicId) => {
      if (enabledMosaicIds.has(mosaicId)) return;
      map.removeLayer(layer);
      layer.dispose();
      cogLayersRef.current.delete(mosaicId);
    });

    enabledMosaics.forEach((mosaic, index) => {
      const current = cogLayersRef.current.get(mosaic.id);
      let layer = current?.layer;
      if (current && current.cogUrl !== mosaic.cogUrl) {
        map.removeLayer(current.layer);
        current.layer.dispose();
        cogLayersRef.current.delete(mosaic.id);
        layer = undefined;
      }

      if (!layer) {
        layer = createPriwaCogLayer(mosaic);
        cogLayersRef.current.set(mosaic.id, {
          cogUrl: mosaic.cogUrl,
          layer,
        });
        map.addLayer(layer);
      }

      layer.setZIndex(20 + (enabledMosaics.length - index) / 100);
    });
  }, [enabledMosaics, mapRef]);

  useEffect(() => {
    const map = mapRef.current;
    const cogLayers = cogLayersRef.current;
    return () => {
      cogLayers.forEach(({ layer }) => {
        map?.removeLayer(layer);
        layer.dispose();
      });
      cogLayers.clear();
    };
  }, [mapRef]);
}
