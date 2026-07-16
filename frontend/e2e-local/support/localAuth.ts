import type { Page } from "@playwright/test";

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
    ({ localSession, acceptCookies }) => {
      window.localStorage.setItem(
        "sb-127-auth-token",
        JSON.stringify(localSession),
      );
      if (acceptCookies)
        window.localStorage.setItem("cookieConsent", "accepted");
    },
    { localSession: session, acceptCookies: options.acceptCookies },
  );

  await page.route(`${options.supabaseUrl}/auth/v1/user`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: session.user,
    });
  });

  return session;
}
