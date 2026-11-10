import type { Query } from "@tanstack/react-query";

/** A short-lived signed link prefix for a folder of files the API guards. */
export interface ISignedFilesGrant {
  /** Absolute prefix of the signed file links. */
  filesUrl: string;
  /** Unix seconds when the links stop working. */
  expiresAt: number;
}

const REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1000;

/** React Query `refetchInterval` that renews a grant a few minutes before it expires. */
export function refreshBeforeExpiry(query: Query<ISignedFilesGrant, Error, ISignedFilesGrant, readonly unknown[]>): number | false {
  const expiresAt = query.state.data?.expiresAt;
  return expiresAt ? Math.max(60_000, expiresAt * 1000 - Date.now() - REFRESH_BEFORE_EXPIRY_MS) : false;
}

/** React Query `staleTime` for a grant: fresh until a few minutes before it expires, so a
 * missed refresh (background tab, no mounted reader) is caught on the next focus or mount. */
export function freshUntilExpiry(query: Query<ISignedFilesGrant, Error, ISignedFilesGrant, readonly unknown[]>): number {
  const { data, dataUpdatedAt } = query.state;
  return data ? Math.max(0, data.expiresAt * 1000 - REFRESH_BEFORE_EXPIRY_MS - dataUpdatedAt) : 0;
}
