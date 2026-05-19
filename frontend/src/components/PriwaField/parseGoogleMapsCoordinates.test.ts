import { describe, expect, it } from "vitest";

import { parseGoogleMapsCoordinates } from "./parseGoogleMapsCoordinates";

const decodedQrUrls = [
  [
    "https://www.google.com/maps/search/?api=1&query=48.456025%2C8.180315",
    48.456025,
    8.180315,
  ],
  [
    "https://www.google.com/maps/search/?api=1&query=48.455937%2C8.180047",
    48.455937,
    8.180047,
  ],
  [
    "https://www.google.com/maps/search/?api=1&query=48.455811%2C8.179944",
    48.455811,
    8.179944,
  ],
  [
    "https://www.google.com/maps/search/?api=1&query=48.455805%2C8.180053",
    48.455805,
    8.180053,
  ],
  [
    "https://www.google.com/maps/search/?api=1&query=48.455851%2C8.180082",
    48.455851,
    8.180082,
  ],
  [
    "https://www.google.com/maps/search/?api=1&query=48.455879%2C8.179991",
    48.455879,
    8.179991,
  ],
  [
    "https://www.google.com/maps/search/?api=1&query=48.455998%2C8.180189",
    48.455998,
    8.180189,
  ],
  [
    "https://www.google.com/maps/search/?api=1&query=48.456106%2C8.180173",
    48.456106,
    8.180173,
  ],
  [
    "https://www.google.com/maps/search/?api=1&query=48.456023%2C8.180116",
    48.456023,
    8.180116,
  ],
  [
    "https://www.google.com/maps/search/?api=1&query=48.455986%2C8.179919",
    48.455986,
    8.179919,
  ],
  [
    "https://www.google.com/maps/search/?api=1&query=48.455991%2C8.180012",
    48.455991,
    8.180012,
  ],
  [
    "https://www.google.com/maps/search/?api=1&query=48.456043%2C8.180224",
    48.456043,
    8.180224,
  ],
  [
    "https://www.google.com/maps/search/?api=1&query=48.455942%2C8.180311",
    48.455942,
    8.180311,
  ],
  [
    "https://www.google.com/maps/search/?api=1&query=48.455939%2C8.180238",
    48.455939,
    8.180238,
  ],
] as const;

describe("parseGoogleMapsCoordinates", () => {
  it.each(decodedQrUrls)(
    "extracts coordinates from supplied QR Google Maps URL %#",
    (url, lat, lon) => {
      expect(parseGoogleMapsCoordinates(url)).toEqual({ lat, lon });
    },
  );

  it("extracts coordinates from common Google Maps URL variants", () => {
    expect(
      parseGoogleMapsCoordinates(
        "https://maps.google.com/?q=48.456025,8.180315",
      ),
    ).toEqual({
      lat: 48.456025,
      lon: 8.180315,
    });
    expect(
      parseGoogleMapsCoordinates(
        "https://www.google.com/maps/@48.456025,8.180315,19z",
      ),
    ).toEqual({
      lat: 48.456025,
      lon: 8.180315,
    });
    expect(parseGoogleMapsCoordinates("48.456025, 8.180315")).toEqual({
      lat: 48.456025,
      lon: 8.180315,
    });
  });

  it("rejects text without usable coordinates", () => {
    expect(
      parseGoogleMapsCoordinates(
        "https://maps.app.goo.gl/example-without-expanded-coordinates",
      ),
    ).toBeNull();
  });

  it("rejects malformed percent escapes without throwing", () => {
    expect(
      parseGoogleMapsCoordinates("https://maps.example/?q=48.45%foo,8.18"),
    ).toBeNull();
  });
});
