import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const source = html.match(
  /<script id="pwa-install-metadata">([\s\S]*?)<\/script>/,
)?.[1];
if (!source) throw new Error("Missing early PWA installation metadata");
const priwaManifest = JSON.parse(
  readFileSync(
    new URL("../../public/priwa.webmanifest", import.meta.url),
    "utf8",
  ),
);

function openPage(path: string) {
  const attributes = new Map<string, string>();
  const listeners = new Map<string, () => void>();
  const window = {
    location: { href: `https://preview.example${path}` },
    addEventListener: (name: string, listener: () => void) =>
      listeners.set(name, listener),
  };
  const document = {
    querySelector: (selector: string) => ({
      setAttribute: (name: string, value: string) =>
        attributes.set(`${selector}:${name}`, value),
    }),
  };
  runInNewContext(source!, { window, document, URL });
  return {
    metadata: () => ({
      manifest: attributes.get('link[rel="manifest"]:href'),
      appleTitle: attributes.get(
        'meta[name="apple-mobile-web-app-title"]:content',
      ),
    }),
    navigate: (path: string) => {
      window.location.href = `https://preview.example${path}`;
      listeners.get("deadtrees:route-change")?.();
    },
  };
}

const priwaIdentity = { manifest: "/priwa.webmanifest", appleTitle: "PRIWA" };
const generalIdentity = {
  manifest: "/manifest.webmanifest",
  appleTitle: "deadtrees.earth",
};

describe("PWA installation identity", () => {
  it.each(["/priwa-field", "/priwa-field/", "/priwa-field?v=preview"])(
    "identifies %s before React starts",
    (path) => {
      expect(openPage(path).metadata()).toEqual(priwaIdentity);
      expect(priwaManifest.start_url).toBe("/priwa-field");
      expect(priwaManifest.id).toBe("/priwa-field");
    },
  );

  it.each(["sign-in", "sign-up", "forgot-password", "reset-password"])(
    "keeps PRIWA identity through %s",
    (path) => {
      expect(
        openPage(`/${path}?returnTo=%2Fpriwa-field%3Fv%3Dpreview`).metadata(),
      ).toEqual(priwaIdentity);
    },
  );

  it("updates for SPA routes and return-address changes without losing PRIWA during login", () => {
    const page = openPage("/deadtrees");
    expect(page.metadata()).toEqual(generalIdentity);
    page.navigate("/priwa-field");
    expect(page.metadata()).toEqual(priwaIdentity);
    page.navigate("/sign-in?returnTo=%2Fpriwa-field");
    expect(page.metadata()).toEqual(priwaIdentity);
    page.navigate("/sign-in?returnTo=%2Fprofile");
    expect(page.metadata()).toEqual(generalIdentity);
    page.navigate("/priwa-field");
    expect(page.metadata()).toEqual(priwaIdentity);
  });

  it.each([
    "/",
    "/deadtrees",
    "/priwa-field-other",
    "/sign-in",
    "/sign-in?returnTo=https%3A%2F%2Fother.example%2Fpriwa-field",
    "/sign-in?returnTo=http%3A%2F%2F%5B",
  ])("preserves the general app for %s", (path) => {
    expect(openPage(path).metadata()).toEqual(generalIdentity);
  });

  it("does not advertise the general manifest before the bootstrap selects the app", () => {
    expect(html).not.toContain(
      '<link rel="manifest" href="/manifest.webmanifest"',
    );
    expect(html.indexOf('id="pwa-install-metadata"')).toBeLessThan(
      html.indexOf('rel="stylesheet"'),
    );
    expect(html.indexOf('id="pwa-install-metadata"')).toBeLessThan(
      html.indexOf('src="/src/main.tsx"'),
    );
  });
});
