import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchPriwaWarnkarteVersions } from "./priwaWarnkarte";

describe("PRIWA Warnkarte API errors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("explains when a preview points to an API without Warnkarte routes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: "Not Found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const request = fetchPriwaWarnkarteVersions("project-1", "token");

    await expect(request).rejects.toMatchObject({
      code: "WARNKARTE_API_UNAVAILABLE",
      message:
        "Die Warnkarten-Funktion ist in dieser Vorschau noch nicht verfügbar. Die Datei wurde nicht validiert.",
      details: { status: 404 },
    });
  });
});
