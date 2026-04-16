type ErrorLike = {
  code?: number | string;
  details?: string;
  error_description?: string;
  hint?: string;
  message?: string;
  name?: string;
  status?: number;
};

export type SessionValidationOutcome =
  | {
      status: "valid";
    }
  | {
      status: "invalid_session";
      reason: string;
    }
  | {
      status: "transient_failure";
      reason: string;
    };

const INVALID_SESSION_MARKERS = [
  "invalidjwttoken",
  "invalid jwt",
  "jwt expired",
  "jwt has expired",
  "session expired",
  "auth session missing",
  "refresh token",
  "user from sub claim in jwt does not exist",
  "jwserror",
];

const INVALID_SESSION_STATUS_CODES = new Set([401, 403]);

function toErrorLike(error: unknown): ErrorLike | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  return error as ErrorLike;
}

export function hasWellFormedJwt(token: string | null | undefined): boolean {
  if (!token) {
    return false;
  }

  return token.split(".").length === 3;
}

export function getAuthErrorText(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return [error.name, error.message].filter(Boolean).join(" ");
  }

  const errorLike = toErrorLike(error);
  if (!errorLike) {
    return "";
  }

  return [
    errorLike.name,
    errorLike.message,
    errorLike.error_description,
    errorLike.details,
    errorLike.hint,
    errorLike.code,
    errorLike.status,
  ]
    .filter((value) => value !== undefined && value !== null && value !== "")
    .join(" ");
}

export function isInvalidSessionError(error: unknown): boolean {
  const errorLike = toErrorLike(error);
  if (errorLike?.status && INVALID_SESSION_STATUS_CODES.has(errorLike.status)) {
    return true;
  }

  const normalizedText = getAuthErrorText(error).toLowerCase();
  if (!normalizedText) {
    return false;
  }

  return INVALID_SESSION_MARKERS.some((marker) => normalizedText.includes(marker));
}

export function classifySessionValidationResult({
  error,
  timedOut = false,
  user,
}: {
  error?: unknown;
  timedOut?: boolean;
  user?: unknown;
}): SessionValidationOutcome {
  if (timedOut) {
    return {
      status: "transient_failure",
      reason: "Auth session validation timed out.",
    };
  }

  if (error) {
    return isInvalidSessionError(error)
      ? {
          status: "invalid_session",
          reason: getAuthErrorText(error) || "Invalid auth session.",
        }
      : {
          status: "transient_failure",
          reason: getAuthErrorText(error) || "Auth session validation failed.",
        };
  }

  if (!user) {
    return {
      status: "invalid_session",
      reason: "Supabase returned no authenticated user for the restored session.",
    };
  }

  return {
    status: "valid",
  };
}
