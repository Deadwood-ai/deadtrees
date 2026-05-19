import type { IPriwaPoint } from "./types";

export const getPriwaPointSourceLabel = (point: IPriwaPoint) => {
  if (point.coordinateSource === "qr") return "QR";
  if (point.coordinateSource === "gps") return "GPS";
  return "Karte";
};

export const getPriwaFundLabel = (point: IPriwaPoint) => {
  if (point.fund === "ja_kein_buchdrucker") return "Ja, kein Buchdrucker";
  if (point.fund === "ja") return "Ja";
  if (point.fund === "nein") return "Nein";
  return "Unsicher";
};

export const isPriwaPointQaCandidate = (point: IPriwaPoint) =>
  point.coordinateSource !== "qr" || point.baumnr.trim().length === 0;

export const getPriwaPointTitle = (point: IPriwaPoint) =>
  point.baumnr.trim() || `Ohne Baumnr · ${point.datum}`;
