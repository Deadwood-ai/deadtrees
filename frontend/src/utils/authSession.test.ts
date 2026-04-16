import { describe, expect, it } from "vitest";

import { getAuthErrorText, hasWellFormedJwt, isInvalidSessionError } from "./authSession";

describe("getAuthErrorText", () => {
  it("combines useful error fields into a searchable string", () => {
    expect(
      getAuthErrorText({
        name: "AuthApiError",
        message: "InvalidJWTToken: JWT expired",
        status: 401,
      }),
    ).toContain("InvalidJWTToken: JWT expired");
  });
});

describe("isInvalidSessionError", () => {
  it("detects invalid JWT errors from structured auth responses", () => {
    expect(
      isInvalidSessionError({
        name: "AuthApiError",
        message: "InvalidJWTToken: JWT expired",
      }),
    ).toBe(true);
  });

  it("detects stale refresh token failures", () => {
    expect(
      isInvalidSessionError({
        message: "Refresh Token Not Found",
      }),
    ).toBe(true);
  });

  it("treats auth 401 responses as invalid local sessions", () => {
    expect(
      isInvalidSessionError({
        status: 401,
        message: "Unauthorized",
      }),
    ).toBe(true);
  });

  it("does not classify unrelated errors as auth-session failures", () => {
    expect(
      isInvalidSessionError({
        message: "Network request failed",
        status: 500,
      }),
    ).toBe(false);
  });
});

describe("hasWellFormedJwt", () => {
  it("detects malformed JWT values", () => {
    expect(hasWellFormedJwt("invalid-jwt-token")).toBe(false);
    expect(hasWellFormedJwt("header.payload.signature")).toBe(true);
  });
});
