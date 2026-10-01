import type { Page } from "@playwright/test";

// Mirrors COOKIE_CONSENT_KEY/VERSION in src/utils/analytics.ts (that module
// reads import.meta.env, so Node cannot import it). Without the current version
// the banner returns and covers mobile controls.
const COOKIE_CONSENT = { key: "cookieConsent", versionKey: "cookieConsentVersion", version: "1.1" };

export async function acceptCookieConsent(page: Page) {
  await page.addInitScript((consent) => {
    window.localStorage.setItem(consent.key, "accepted");
    window.localStorage.setItem(consent.versionKey, consent.version);
  }, COOKIE_CONSENT);
}

export interface LocalAuthUser {
  id: string;
  email: string;
}

const createUnsignedJwt = (user: LocalAuthUser) => {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");

  return [
    encode({ alg: "none", typ: "JWT" }),
    encode({
      aud: "authenticated",
      role: "authenticated",
      sub: user.id,
      email: user.email,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    "local-e2e",
  ].join(".");
};

export function createLocalSession(user: LocalAuthUser, refreshToken: string) {
  const now = new Date().toISOString();
  return {
    access_token: createUnsignedJwt(user),
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: refreshToken,
    user: {
      id: user.id,
      aud: "authenticated",
      role: "authenticated",
      email: user.email,
      email_confirmed_at: now,
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: {},
      created_at: now,
      updated_at: now,
    },
  };
}

export async function installLocalSession(
  page: Page,
  options: {
    user: LocalAuthUser;
    supabaseUrl: string;
    refreshToken: string;
    acceptCookies?: boolean;
  },
) {
  const session = createLocalSession(options.user, options.refreshToken);

  await page.addInitScript(
    ({ localSession }) => {
      window.localStorage.setItem(
        "sb-127-auth-token",
        JSON.stringify(localSession),
      );
    },
    { localSession: session },
  );
  if (options.acceptCookies) await acceptCookieConsent(page);

  await page.route(`${options.supabaseUrl}/auth/v1/user`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: session.user,
    });
  });

  return session;
}
