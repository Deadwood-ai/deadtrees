import { useCallback, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import Feature from "ol/Feature";
import type { FeatureLike } from "ol/Feature";
import { Point } from "ol/geom";
import Geometry from "ol/geom/Geometry";
import { circular as circularPolygon } from "ol/geom/Polygon";
import VectorLayer from "ol/layer/Vector";
import { fromLonLat, toLonLat } from "ol/proj";
import VectorSource from "ol/source/Vector";
import { Circle as CircleStyle, Fill, Icon, Stroke, Style } from "ol/style";
import type { Map } from "ol";
import createKompas from "kompas";

const LOCATION_HEADING_ICON_SRC = "/assets/location-heading.svg";

type DeviceOrientationWithPermission = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

interface KompasTracker {
  watch(): KompasTracker;
  clear(): KompasTracker;
  on(eventName: "heading", callback: (heading: number) => void): KompasTracker;
}

const getGeolocationErrorMessage = (error: GeolocationPositionError) => {
  if (!window.isSecureContext) {
    return "Standort braucht HTTPS oder localhost. Bitte diese Testversion über eine sichere Adresse öffnen.";
  }

  if (error.code === error.PERMISSION_DENIED) {
    return "Standort ist blockiert. Bitte Standort für diese Website und Safari/Brave in den System- und Browser-Einstellungen erlauben.";
  }

  if (error.code === error.POSITION_UNAVAILABLE) {
    return "Standort ist gerade nicht verfügbar. Auf macOS hilft oft WLAN aktivieren, weil Safari/Brave Standort über Systemdienste beziehen.";
  }

  if (error.code === error.TIMEOUT) {
    return "Standortabfrage hat zu lange gedauert. Bitte draußen oder mit besserem Empfang erneut versuchen.";
  }

  return "Standort konnte nicht ermittelt werden.";
};

const userAccuracyStyle = new Style({
  fill: new Fill({ color: "rgba(59, 130, 246, 0.16)" }),
  stroke: new Stroke({ color: "rgba(59, 130, 246, 0.32)", width: 1.5 }),
});

const userLocationStyle = (feature: FeatureLike) => {
  if (feature.getGeometry()?.getType() === "Polygon") {
    return userAccuracyStyle;
  }

  const heading = feature.get("heading");
  const rotation =
    typeof heading === "number" && Number.isFinite(heading)
      ? (heading * Math.PI) / 180
      : 0;

  return [
    new Style({
      image: new Icon({
        src: LOCATION_HEADING_ICON_SRC,
        anchor: [0.5, 0.5],
        anchorXUnits: "fraction",
        anchorYUnits: "fraction",
        rotateWithView: true,
        rotation,
        scale: 0.9,
      }),
      zIndex: 61,
    }),
    new Style({
      image: new CircleStyle({
        radius: 5.5,
        fill: new Fill({ color: "rgba(37, 99, 235, 0.98)" }),
        stroke: new Stroke({ color: "rgba(255,255,255,0.96)", width: 2.5 }),
      }),
      zIndex: 62,
    }),
  ];
};

export const useUserLocationLayer = (mapRef: MutableRefObject<Map | null>) => {
  const geolocationWatchIdRef = useRef<number | null>(null);
  const userLocationFeatureRef = useRef<Feature<Point> | null>(null);
  const userAccuracyFeatureRef = useRef<Feature<Geometry> | null>(null);
  const shouldAnimateToUserRef = useRef(false);
  const compassTrackerRef = useRef<KompasTracker | null>(null);

  const [isTracking, setIsTracking] = useState(false);
  const [isLocating, setIsLocating] = useState(false);
  const [hasFix, setHasFix] = useState(false);
  const [hasZoomedToUser, setHasZoomedToUser] = useState(false);
  const [isHeadingActive, setIsHeadingActive] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [currentCoordinate, setCurrentCoordinate] = useState<{
    lat: number;
    lon: number;
  } | null>(null);

  const layer = useMemo(
    () =>
      new VectorLayer({
        source: new VectorSource<Feature<Geometry>>(),
        style: userLocationStyle,
        zIndex: 60,
      }),
    [],
  );

  const animateToUserLocation = useCallback(
    (coordinates: number[]) => {
      const view = mapRef.current?.getView();
      if (!view) return;

      view.animate({
        center: coordinates,
        zoom: Math.max(view.getZoom() || 0, 18),
        duration: 600,
      });
      setHasZoomedToUser(true);
    },
    [mapRef],
  );

  const updateUserHeading = useCallback((heading: number | null) => {
    const userFeature = userLocationFeatureRef.current;
    if (
      !userFeature ||
      typeof heading !== "number" ||
      !Number.isFinite(heading)
    )
      return;

    userFeature.set("heading", heading);
    userFeature.changed();
    setIsHeadingActive(true);
  }, []);

  const updateUserLocationFeature = useCallback(
    (
      coordinates: number[],
      accuracyInMeters?: number | null,
      heading?: number | null,
    ) => {
      const userLocationSource = layer.getSource();
      if (!userLocationSource) return;

      let userFeature = userLocationFeatureRef.current;
      if (!userFeature) {
        userFeature = new Feature({ geometry: new Point(coordinates) });
        userLocationFeatureRef.current = userFeature;
        userLocationSource.addFeature(userFeature);
      } else {
        userFeature.setGeometry(new Point(coordinates));
      }

      let accuracyFeature = userAccuracyFeatureRef.current;
      if (
        typeof accuracyInMeters === "number" &&
        Number.isFinite(accuracyInMeters) &&
        accuracyInMeters > 0
      ) {
        const accuracyGeometry = circularPolygon(
          toLonLat(coordinates),
          accuracyInMeters,
          64,
        );
        accuracyGeometry.transform(
          "EPSG:4326",
          mapRef.current?.getView().getProjection() ?? "EPSG:3857",
        );

        if (!accuracyFeature) {
          accuracyFeature = new Feature({ geometry: accuracyGeometry });
          userAccuracyFeatureRef.current = accuracyFeature;
          userLocationSource.addFeature(accuracyFeature);
        } else {
          accuracyFeature.setGeometry(accuracyGeometry);
        }
        accuracyFeature.changed();
      } else if (accuracyFeature) {
        userLocationSource.removeFeature(accuracyFeature);
        userAccuracyFeatureRef.current = null;
      }

      if (typeof heading === "number" && Number.isFinite(heading)) {
        userFeature.set("heading", heading);
        setIsHeadingActive(true);
      }

      userFeature.changed();
      setHasFix(true);
    },
    [layer, mapRef],
  );

  const startOrientationTracking = useCallback(
    async (requestPermission: boolean) => {
      if (
        typeof window === "undefined" ||
        typeof DeviceOrientationEvent === "undefined"
      )
        return;

      const OrientationEventWithPermission =
        DeviceOrientationEvent as DeviceOrientationWithPermission;
      if (
        requestPermission &&
        typeof OrientationEventWithPermission.requestPermission === "function"
      ) {
        try {
          const permission =
            await OrientationEventWithPermission.requestPermission();
          if (permission !== "granted") return;
        } catch {
          return;
        }
      } else if (
        !requestPermission &&
        typeof OrientationEventWithPermission.requestPermission === "function"
      ) {
        return;
      }

      if (compassTrackerRef.current) return;

      const tracker = createKompas().on("heading", updateUserHeading).watch();
      compassTrackerRef.current = tracker;
      setIsHeadingActive(true);
    },
    [updateUserHeading],
  );

  const stop = useCallback(() => {
    if (geolocationWatchIdRef.current !== null) {
      navigator.geolocation.clearWatch(geolocationWatchIdRef.current);
      geolocationWatchIdRef.current = null;
    }

    compassTrackerRef.current?.clear();
    compassTrackerRef.current = null;
    setIsTracking(false);
    setIsLocating(false);
    setIsHeadingActive(false);
  }, []);

  const locateUser = useCallback(
    async (requestOrientationPermission = false) => {
      if (!navigator.geolocation) {
        setLocationError("Dieser Browser unterstützt keine Standortabfrage.");
        return;
      }

      if (!window.isSecureContext) {
        setLocationError(
          "Standort braucht HTTPS oder localhost. Bitte diese Testversion über eine sichere Adresse öffnen.",
        );
        return;
      }

      try {
        const permissionStatus = await navigator.permissions?.query({
          name: "geolocation" as PermissionName,
        });
        if (permissionStatus?.state === "denied") {
          setLocationError(
            "Standort ist im Browser blockiert. Bitte Website-Einstellungen für diese Adresse zurücksetzen oder Standort erlauben.",
          );
          return;
        }
      } catch {
        // Safari may not expose a useful Permissions API state for geolocation.
      }

      setLocationError(null);
      void startOrientationTracking(requestOrientationPermission);
      shouldAnimateToUserRef.current = true;
      setIsTracking(true);
      setIsLocating(true);

      const existingCoordinates = userLocationFeatureRef.current
        ?.getGeometry()
        ?.getCoordinates();
      if (existingCoordinates) {
        animateToUserLocation(existingCoordinates);
        shouldAnimateToUserRef.current = false;
        setIsLocating(false);
      }

      if (geolocationWatchIdRef.current !== null) return;

      geolocationWatchIdRef.current = navigator.geolocation.watchPosition(
        (position) => {
          const { latitude, longitude } = position.coords;
          const center = fromLonLat([longitude, latitude]);
          const heading =
            typeof position.coords.heading === "number" &&
            Number.isFinite(position.coords.heading)
              ? position.coords.heading
              : null;

          setCurrentCoordinate({ lat: latitude, lon: longitude });
          updateUserLocationFeature(center, position.coords.accuracy, heading);
          if (shouldAnimateToUserRef.current) {
            animateToUserLocation(center);
            shouldAnimateToUserRef.current = false;
          }
          setIsTracking(true);
          setIsLocating(false);
        },
        (error) => {
          setLocationError(getGeolocationErrorMessage(error));
          stop();
          shouldAnimateToUserRef.current = false;
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 120000,
        },
      );
    },
    [
      animateToUserLocation,
      startOrientationTracking,
      stop,
      updateUserLocationFeature,
    ],
  );

  return {
    layer,
    locateUser,
    stop,
    isTracking,
    isLocating,
    hasFix,
    hasZoomedToUser,
    isHeadingActive,
    locationError,
    currentCoordinate,
  };
};
