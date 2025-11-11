import { accessTokenExpired } from "./auth";
import type { OAuthAuthDetails } from "./types";

const authCache = new Map<string, OAuthAuthDetails>();

function normalizeRefreshKey(refresh?: string): string | undefined {
  const key = refresh?.trim();
  return key ? key : undefined;
}

export function resolveCachedAuth(auth: OAuthAuthDetails): OAuthAuthDetails {
  const key = normalizeRefreshKey(auth.refresh);
  if (!key) {
    return auth;
  }

  const cached = authCache.get(key);
  if (!cached) {
    authCache.set(key, auth);
    return auth;
  }

  if (!accessTokenExpired(auth)) {
    authCache.set(key, auth);
    return auth;
  }

  if (!accessTokenExpired(cached)) {
    return cached;
  }

  authCache.set(key, auth);
  return auth;
}

export function storeCachedAuth(auth: OAuthAuthDetails): void {
  const key = normalizeRefreshKey(auth.refresh);
  if (!key) {
    return;
  }
  authCache.set(key, auth);
}

export function clearCachedAuth(refresh?: string): void {
  if (!refresh) {
    authCache.clear();
    return;
  }
  const key = normalizeRefreshKey(refresh);
  if (key) {
    authCache.delete(key);
  }
}
