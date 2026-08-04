import type { PriwaCoordinateSource } from "./types";

interface IPriwaCoordinateSourcePresentation {
  mapLabel: string;
  detailLabel: string;
}

const presentations: Record<
  PriwaCoordinateSource,
  IPriwaCoordinateSourcePresentation
> = {
  qr: { mapLabel: "QR", detailLabel: "QR-Code" },
  gps: { mapLabel: "GPS", detailLabel: "GPS-Position" },
  map: { mapLabel: "Karte", detailLabel: "Auf Karte gesetzt" },
};

export const getPriwaCoordinateSourcePresentation = (
  source: PriwaCoordinateSource,
) => presentations[source];
