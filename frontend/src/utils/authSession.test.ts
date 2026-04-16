import { describe, expect, it } from "vitest";

import { classifySessionValidationResult, getAuthErrorText, hasWellFormedJwt, isInvalidSessionError } from "./authSession";

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

describe("classifySessionValidationResult", () => {
  it("treats timeouts as transient validation failures", () => {
    expect(classifySessionValidationResult({ timedOut: true })).toEqual({
      status: "transient_failure",
      reason: "Auth session validation timed out.",
    });
  });

  it("treats non-auth failures as transient validation failures", () => {
    expect(
      classifySessionValidationResult({
        error: new Error("Service unavailable"),
      }),
    ).toEqual({
      status: "transient_failure",
      reason: "Error Service unavailable",
    });
  });

  it("treats invalid auth responses as invalid sessions", () => {
    expect(
      classifySessionValidationResult({
        error: {
          message: "InvalidJWTToken: JWT expired",
          status: 401,
        },
      }),
    ).toEqual({
      status: "invalid_session",
      reason: "InvalidJWTToken: JWT expired 401",
    });
  });

  it("treats missing users as invalid sessions", () => {
    expect(classifySessionValidationResult({ user: null })).toEqual({
      status: "invalid_session",
      reason: "Supabase returned no authenticated user for the restored session.",
    });
  });
});
